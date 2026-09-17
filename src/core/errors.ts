import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import { CliError, EXIT, type ExitCode } from "./exit.ts";

/** A single field-level complaint from the API's 422 validation response. */
export interface FieldIssue {
  /** Dotted path to the offending field, e.g. `questions.severity.criteria`. */
  path: string;
  /** Human-readable explanation from the server. */
  message: string;
}

/** The CLI's single normalized error shape, regardless of which API failure produced it. */
export interface NormalizedError {
  /** Stable machine-readable discriminator. */
  type: string;
  message: string;
  status?: number;
  request_id?: string;
  /** Field-level detail, present only for validation failures. */
  issues?: FieldIssue[];
  /** Suggested next step for a human or agent reading the failure. */
  hint?: string;
}

/**
 * The API returns three mutually incompatible bodies under `detail`:
 *
 *   1. `{"detail": {"error_type": "...", "message": "..."}}`  (auth and usage errors)
 *   2. `{"detail": "Too many choices. Must have at most 255 choices."}` (a plain string)
 *   3. `{"detail": [{"type","loc","msg","input","ctx"}]}` (FastAPI field validation)
 *
 * Collapse all three into one message plus optional field issues.
 */
export function parseErrorBody(body: unknown): { message?: string; type?: string; issues?: FieldIssue[] } {
  if (typeof body === "string") return { message: body.trim() || undefined };
  if (!body || typeof body !== "object") return {};

  const detail = (body as Record<string, unknown>).detail;

  // Shape 2: detail is a bare string.
  if (typeof detail === "string") return { message: detail };

  // Shape 3: detail is an array of field issues.
  if (Array.isArray(detail)) {
    const issues: FieldIssue[] = detail.map((raw) => {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const loc = Array.isArray(entry.loc) ? entry.loc : [];
      // Drop the leading "body" segment; it is noise for a CLI user.
      const path = loc.filter((s) => s !== "body").join(".") || "(request)";
      const message = typeof entry.msg === "string" ? entry.msg : "Invalid value";
      return { path, message };
    });
    const summary = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    return { type: "validation_error", message: summary || "Request validation failed", issues };
  }

  // Shape 1: detail is an object with error_type and message.
  if (detail && typeof detail === "object") {
    const entry = detail as Record<string, unknown>;
    return {
      type: typeof entry.error_type === "string" ? entry.error_type : undefined,
      message: typeof entry.message === "string" ? entry.message : undefined,
    };
  }

  return {};
}

/** Map an HTTP status onto the CLI's exit code contract. */
export function exitCodeForStatus(status: number): ExitCode {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 429) return EXIT.RATE_LIMIT;
  if (status >= 500) return EXIT.SERVER;
  // 400 and 422 mean the request we built was wrong, which is a usage error here.
  return EXIT.USAGE;
}

function hintForStatus(status: number, message: string): string | undefined {
  if (status === 401 || status === 403) {
    return "Run `tsai auth status` to check the key, or `tsai auth login` to set one.";
  }
  if (status === 429) return "Rate limited after retries. Lower --concurrency or retry later.";
  if (status >= 500) return "A server-side failure. Retry shortly; quote the request id if it persists.";
  if (/at most 255 choices/i.test(message)) {
    return "Split the options across multiple questions, or let `tsai find`/`rank` window them for you.";
  }
  if (/at most 10 levels/i.test(message)) return "A score question accepts between 2 and 10 levels.";
  if (/unknown model/i.test(message)) return "Run `tsai models` to list the models your key can use.";
  return undefined;
}

/** Convert any thrown value into the CLI's normalized error plus an exit code. */
export function normalizeError(error: unknown): { normalized: NormalizedError; code: ExitCode } {
  if (error instanceof CliError) {
    return {
      normalized: {
        type: error.code === EXIT.GATE ? "gate_not_met" : "usage_error",
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.details ?? {}),
      },
      code: error.code,
    };
  }

  if (error instanceof APIError) {
    const parsed = parseErrorBody(error.body);
    const message = parsed.message ?? error.message;
    const code = exitCodeForStatus(error.status);
    let type = parsed.type;
    if (!type) {
      if (error instanceof AuthenticationError) type = "authentication_error";
      else if (error instanceof PermissionDeniedError) type = "permission_denied";
      else if (error instanceof RateLimitError) type = "rate_limit_error";
      else type = "api_error";
    }
    const hint = hintForStatus(error.status, message);
    return {
      normalized: {
        type,
        message,
        status: error.status,
        ...(error.requestId ? { request_id: error.requestId } : {}),
        ...(parsed.issues ? { issues: parsed.issues } : {}),
        ...(hint ? { hint } : {}),
      },
      code,
    };
  }

  if (error instanceof APITimeoutError) {
    return {
      normalized: {
        type: "timeout_error",
        message: `Request timed out after ${error.timeoutMs} ms.`,
        hint: "Raise --timeout, or send a smaller state.",
      },
      code: EXIT.CONNECTION,
    };
  }

  if (error instanceof APIConnectionError) {
    return {
      normalized: {
        type: "connection_error",
        message: error.message,
        hint: "Check network access to the API host.",
      },
      code: EXIT.CONNECTION,
    };
  }

  if (error instanceof APIUserAbortError) {
    return { normalized: { type: "aborted", message: "Request cancelled." }, code: EXIT.CONNECTION };
  }

  if (error instanceof TypeSafeError) {
    // The SDK validates locally too (missing key, empty questions, bad score criteria).
    const missingKey = /api key/i.test(error.message);
    return {
      normalized: {
        type: "configuration_error",
        message: error.message,
        ...(missingKey ? { hint: "Set TYPESAFE_API_KEY or run `tsai auth login`." } : {}),
      },
      code: EXIT.USAGE,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { normalized: { type: "internal_error", message }, code: EXIT.INTERNAL };
}
