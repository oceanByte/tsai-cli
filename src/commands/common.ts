import type { EntryType, Questions } from "@typesafe-ai/sdk";
import { Runner } from "../core/client.ts";
import { resolveConfig, type ConfigOverrides } from "../core/config.ts";
import { usageError } from "../core/exit.ts";
import type { GateOptions } from "../core/gate.ts";
import { hasStdin, readStdin, resolveQuestions, resolveState } from "../core/input.ts";
import { printJson, resolveOutputMode, type OutputMode } from "../render/output.ts";
import type { FlagSpec } from "../router.ts";

/** Parsed flag bag handed to every command. */
export type Flags = Record<string, unknown>;

export const str = (flags: Flags, name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined;

export const num = (flags: Flags, name: string): number | undefined =>
  typeof flags[name] === "number" ? (flags[name] as number) : undefined;

export const bool = (flags: Flags, name: string): boolean => flags[name] === true;

/** Values of a repeatable flag, normalized to an array even when given once. */
export const list = (flags: Flags, name: string): string[] => {
  const value = flags[name];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") return [value];
  return [];
};

export function required(flags: Flags, name: string, hint: string): string {
  const value = str(flags, name);
  if (value === undefined || value.trim() === "") throw usageError(`--${name} is required.`, hint);
  return value;
}

/** Read stdin at most once per process, so two resolvers can both consult it. */
let stdinCache: Promise<string> | undefined;
export function stdinText(): Promise<string> {
  if (!hasStdin()) return Promise.resolve("");
  stdinCache ??= readStdin();
  return stdinCache;
}

export function outputFrom(flags: Flags): OutputMode {
  return resolveOutputMode({
    json: bool(flags, "json"),
    pretty: bool(flags, "pretty"),
    quiet: bool(flags, "quiet"),
    ...(str(flags, "field") ? { field: str(flags, "field") as string } : {}),
  });
}

/** Build a Runner with the global flags layered over env, config files and defaults. */
export function makeRunner(flags: Flags): Runner {
  const overrides: ConfigOverrides = {};
  const apiKey = str(flags, "api-key");
  const baseURL = str(flags, "base-url");
  const model = str(flags, "model");
  if (apiKey) overrides.apiKey = apiKey;
  if (baseURL) overrides.baseURL = baseURL;
  if (model) overrides.model = model;
  if (num(flags, "timeout") !== undefined) overrides.timeout = num(flags, "timeout");
  if (num(flags, "retries") !== undefined) overrides.retries = num(flags, "retries");
  if (num(flags, "concurrency") !== undefined) overrides.concurrency = num(flags, "concurrency");
  if (bool(flags, "no-cache")) overrides.cache = false;
  return new Runner(resolveConfig(overrides));
}

/** Flags that name the state to judge. Shared by every command that sends one. */
export const STATE_FLAGS: Record<string, FlagSpec> = {
  state: { type: "string", short: "s", value: "<text>", description: "State as literal text" },
  "state-file": { type: "string", value: "<path>", description: "Read state from a file" },
  "state-json": { type: "string", value: "<json>", description: "State as raw JSON, for structured input" },
};

export async function loadState(flags: Flags, positionals: string[]): Promise<EntryType> {
  // Only fall back to stdin when no state was named explicitly. Reading a stream that
  // will never deliver data would hang the command, and an agent harness routinely
  // leaves an idle pipe attached to stdin.
  const explicit =
    positionals.length > 0 ||
    str(flags, "state") !== undefined ||
    str(flags, "state-file") !== undefined ||
    str(flags, "state-json") !== undefined;
  const stdin = explicit ? "" : await stdinText();
  return resolveState({
    files: positionals,
    ...(str(flags, "state") !== undefined ? { text: str(flags, "state") as string } : {}),
    ...(str(flags, "state-file") !== undefined ? { file: str(flags, "state-file") as string } : {}),
    ...(str(flags, "state-json") !== undefined ? { json: str(flags, "state-json") as string } : {}),
    ...(stdin ? { stdin } : {}),
  });
}

/** Flags that name the question set, for the commands that take arbitrary questions. */
export const QUESTION_FLAGS: Record<string, FlagSpec> = {
  questions: { type: "string", value: "<path>", description: "Question set as a JSON file, or - for stdin" },
  question: {
    type: "string",
    short: "q",
    multiple: true,
    value: "<json>",
    description: "Inline question JSON, repeatable",
  },
};

export async function loadQuestions(flags: Flags): Promise<Questions> {
  // `--questions -` is the only way questions arrive on stdin, so that is the only
  // case where reading it is safe.
  const stdin = str(flags, "questions") === "-" ? await stdinText() : "";
  return resolveQuestions({
    ...(str(flags, "questions") !== undefined ? { file: str(flags, "questions") as string } : {}),
    inline: list(flags, "question"),
    ...(stdin ? { stdin } : {}),
  });
}

/** Assertion flags. Present on every command that produces answers. */
export const GATE_FLAGS: Record<string, FlagSpec> = {
  "min-confidence": {
    type: "number",
    value: "<0-1>",
    description: "Exit 6 unless every choice and score answer is at least this confident",
  },
  "min-noul": { type: "number", value: "<0-1>", description: "Exit 6 unless every noul answer is at least this" },
  "max-noul": { type: "number", value: "<0-1>", description: "Exit 6 unless every noul answer is at most this" },
  expect: { type: "string", value: "<label>", description: "Exit 6 unless every choice answer equals this label" },
  "min-score": { type: "number", value: "<n>", description: "Exit 6 unless every score answer is at least this" },
  "max-score": { type: "number", value: "<n>", description: "Exit 6 unless every score answer is at most this" },
};

export function gatesFrom(flags: Flags): GateOptions {
  const gates: GateOptions = {};
  const minConfidence = num(flags, "min-confidence");
  const minNoul = num(flags, "min-noul");
  const maxNoul = num(flags, "max-noul");
  const expect = str(flags, "expect");
  const minScore = num(flags, "min-score");
  const maxScore = num(flags, "max-score");
  if (minConfidence !== undefined) gates.minConfidence = minConfidence;
  if (minNoul !== undefined) gates.minNoul = minNoul;
  if (maxNoul !== undefined) gates.maxNoul = maxNoul;
  if (expect !== undefined) gates.expect = expect;
  if (minScore !== undefined) gates.minScore = minScore;
  if (maxScore !== undefined) gates.maxScore = maxScore;
  return gates;
}

/** The distinct primitive types in a question set, used to reject impossible gates. */
export const questionTypes = (questions: Questions): Set<string> =>
  new Set(Object.values(questions).map((q) => q.type));

/** Print the request instead of sending it. Returns true when the command should stop. */
export function maybeDryRun(flags: Flags, payload: unknown, mode: OutputMode): boolean {
  if (!bool(flags, "dry-run")) return false;
  printJson({ dry_run: true, endpoint: "POST /v1/systemone", body: payload }, mode);
  return true;
}

/** Clamp a probability flag, rejecting values that can never match an answer. */
export function probability(flags: Flags, name: string, fallback: number): number {
  const value = num(flags, name);
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw usageError(`--${name} must be between 0 and 1.`);
  }
  return value;
}

/** Truncate a candidate so one oversized file cannot dominate the token bill. */
export function clip(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated, ${text.length - maxChars} more characters]`;
}
