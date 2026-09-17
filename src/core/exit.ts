/**
 * Process exit codes. These are a public contract: agents and CI pipelines branch on
 * them, so the numbers must not be reassigned once released.
 */
export const EXIT = {
  /** Command completed and any assertions passed. */
  OK: 0,
  /** Unexpected internal failure. A bug in this CLI. */
  INTERNAL: 1,
  /** Bad invocation or invalid input, caught locally before any request was billed. */
  USAGE: 2,
  /** HTTP 401 or 403. Missing, invalid, or unauthorized API key. */
  AUTH: 3,
  /** HTTP 429 after the retry policy was exhausted. */
  RATE_LIMIT: 4,
  /** HTTP 5xx, including 529 overloaded. */
  SERVER: 5,
  /** The command succeeded but a --min-confidence / --expect / --fail-on assertion failed. */
  GATE: 6,
  /** DNS, TLS, socket failure, or timeout. */
  CONNECTION: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Thrown for any condition that should end the process with a specific code. */
export class CliError extends Error {
  readonly code: ExitCode;
  /** Optional actionable next step, printed on its own line after the message. */
  readonly hint: string | undefined;
  /** Structured payload emitted instead of the message when output is JSON. */
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ExitCode,
    message: string,
    options: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CliError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

/** A usage error: the invocation was wrong and nothing was sent to the API. */
export const usageError = (message: string, hint?: string): CliError =>
  new CliError(EXIT.USAGE, message, { hint });

/** A gate failure: the request succeeded but an assertion on the answer did not hold. */
export const gateError = (message: string, details?: Record<string, unknown>): CliError =>
  new CliError(EXIT.GATE, message, { details });
