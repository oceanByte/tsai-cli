import { TypeSafeClient, type EntryType, type ModelCard, type Questions, type Usage } from "@typesafe-ai/sdk";
import { ResponseCache, cacheKey } from "./cache.ts";
import type { ResolvedConfig } from "./config.ts";
import { addUsage, emptyCost, type CostSummary } from "./cost.ts";
import { CliError, EXIT } from "./exit.ts";
import { validateQuestions, validateState } from "./validate.ts";

/** The request body sent to POST /v1/systemone. */
export interface SystemOnePayload {
  state: EntryType;
  questions: Questions;
  model: string;
}

/** A noul answer. Note there is no confidence field: the API does not return one. */
export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted position across level indices, so it lands between levels. */
  score: number;
  confidence: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResponse {
  /** The versioned model that actually served the request, e.g. `jev-1.13.0`. */
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
  /** From the `x-typesafe-request-id` header. Absent on a cache hit. */
  requestId?: string;
  /** True when this response was served from the local cache and cost nothing. */
  cached: boolean;
}

/**
 * Wraps the official SDK with the behavior every command needs: local validation
 * before spending, a content-addressed cache, cumulative usage accounting, and
 * capture of the request id for support.
 */
export class Runner {
  readonly config: ResolvedConfig;
  readonly cache: ResponseCache;
  readonly cost: CostSummary = emptyCost();
  /** Requests served from cache. Reported alongside cost so savings are visible. */
  cacheHits = 0;
  private client: TypeSafeClient | undefined;

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.cache = new ResponseCache(config.settings.cache);
  }

  /**
   * Construct the SDK client lazily, so commands that never reach the network
   * (--dry-run, --help, schema) work without an API key configured.
   */
  private sdk(): TypeSafeClient {
    if (this.client) return this.client;
    const { apiKey, baseURL, model, timeout, retries } = this.config.settings;
    if (!apiKey) {
      throw new CliError(EXIT.AUTH, "No API key configured.", {
        hint: "Run `tsai auth login`, or set TYPESAFE_API_KEY in the environment.",
      });
    }
    this.client = new TypeSafeClient({
      apiKey,
      baseURL,
      defaultModel: model,
      timeout,
      retry: { maxRetries: retries },
      // The CLI renders its own diagnostics; keep the SDK quiet.
      logLevel: "error",
    });
    return this.client;
  }

  /** Assemble the exact request body, validating it before it can cost anything. */
  buildPayload(state: EntryType, questions: Questions, model?: string): SystemOnePayload {
    validateState(state);
    validateQuestions(questions);
    return { state, questions, model: model ?? this.config.settings.model };
  }

  async systemOne(payload: SystemOnePayload, signal?: AbortSignal): Promise<SystemOneResponse> {
    const key = cacheKey(payload, this.config.settings.baseURL);
    const hit = this.cache.get<Omit<SystemOneResponse, "cached">>(key);
    if (hit) {
      this.cacheHits += 1;
      return { ...hit, cached: true };
    }

    const { data, requestId } = await this.sdk()
      .systemOne(payload as never, signal ? { signal } : undefined)
      .withResponse();

    const result = {
      model: data.model,
      answers: data.answers as unknown as Record<string, Answer>,
      usage: data.usage,
      ...(requestId ? { requestId } : {}),
    };
    this.cache.set(key, result);
    addUsage(this.cost, data.usage);
    return { ...result, cached: false };
  }

  async listModels(): Promise<ModelCard[]> {
    return await this.sdk().models.list();
  }
}

/**
 * Run tasks with a bounded number in flight, preserving input order in the results.
 *
 * Recipes that vary state per item (rank, verify) cannot batch into one request, so
 * cost scales with the item count. A pool keeps that fan-out from tripping the rate
 * limit while still finishing in roughly wall-clock/concurrency time.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** Outcome of one item in a fan-out, so a single failure does not abort the run. */
export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

export async function settledPool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  return await pool(items, limit, async (item, index) => {
    try {
      return { ok: true as const, value: await task(item, index) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
}
