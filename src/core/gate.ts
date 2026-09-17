import type { Answer } from "./client.ts";
import { gateError, usageError } from "./exit.ts";

/**
 * Assertions that turn any command into a CI or hook check.
 *
 * A failed assertion exits 6, which is distinct from an API failure so a caller can
 * tell "the model disagreed" apart from "the request did not work".
 */
export interface GateOptions {
  /** Minimum confidence for choice and score answers. */
  minConfidence?: number;
  /** Minimum probability of yes for noul answers. */
  minNoul?: number;
  /** Maximum probability of yes for noul answers. */
  maxNoul?: number;
  /** Required label for a choice answer. */
  expect?: string;
  /** Minimum value for a score answer. */
  minScore?: number;
  /** Maximum value for a score answer. */
  maxScore?: number;
}

export const hasGates = (gates: GateOptions): boolean =>
  gates.minConfidence !== undefined ||
  gates.minNoul !== undefined ||
  gates.maxNoul !== undefined ||
  gates.expect !== undefined ||
  gates.minScore !== undefined ||
  gates.maxScore !== undefined;

function assertRange(name: string, value: number | undefined, max: number): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw usageError(`--${name} must be a number between 0 and ${max}.`);
  }
}

/** Reject gate combinations that can never be evaluated, before any request is sent. */
export function validateGates(gates: GateOptions, types: ReadonlySet<string>): void {
  assertRange("min-confidence", gates.minConfidence, 1);
  assertRange("min-noul", gates.minNoul, 1);
  assertRange("max-noul", gates.maxNoul, 1);

  if (gates.minNoul !== undefined && gates.maxNoul !== undefined && gates.minNoul > gates.maxNoul) {
    throw usageError("--min-noul cannot be greater than --max-noul.");
  }

  // The API returns no confidence on a noul answer, so gating on it is meaningless.
  if (gates.minConfidence !== undefined && types.size > 0 && !types.has("choice") && !types.has("score")) {
    throw usageError(
      "--min-confidence needs a choice or score question.",
      "Noul answers carry no confidence value. Use --min-noul or --max-noul instead.",
    );
  }
  if ((gates.minNoul !== undefined || gates.maxNoul !== undefined) && types.size > 0 && !types.has("noul")) {
    throw usageError("--min-noul and --max-noul need a noul question.");
  }
  if (gates.expect !== undefined && types.size > 0 && !types.has("choice")) {
    throw usageError("--expect needs a choice question.");
  }
  if ((gates.minScore !== undefined || gates.maxScore !== undefined) && types.size > 0 && !types.has("score")) {
    throw usageError("--min-score and --max-score need a score question.");
  }
}

export interface GateFailure {
  question: string;
  check: string;
  expected: string;
  actual: number | string;
}

/** Evaluate every gate against every applicable answer, collecting all failures. */
export function evaluateGates(answers: Record<string, Answer>, gates: GateOptions): GateFailure[] {
  const failures: GateFailure[] = [];

  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === "noul") {
      if (gates.minNoul !== undefined && answer.noul < gates.minNoul) {
        failures.push({
          question: id,
          check: "min-noul",
          expected: `>= ${gates.minNoul}`,
          actual: answer.noul,
        });
      }
      if (gates.maxNoul !== undefined && answer.noul > gates.maxNoul) {
        failures.push({
          question: id,
          check: "max-noul",
          expected: `<= ${gates.maxNoul}`,
          actual: answer.noul,
        });
      }
      continue;
    }

    if (gates.minConfidence !== undefined && answer.confidence < gates.minConfidence) {
      failures.push({
        question: id,
        check: "min-confidence",
        expected: `>= ${gates.minConfidence}`,
        actual: answer.confidence,
      });
    }

    if (answer.type === "choice" && gates.expect !== undefined && answer.choice !== gates.expect) {
      failures.push({
        question: id,
        check: "expect",
        expected: gates.expect,
        actual: answer.choice,
      });
    }

    if (answer.type === "score") {
      if (gates.minScore !== undefined && answer.score < gates.minScore) {
        failures.push({ question: id, check: "min-score", expected: `>= ${gates.minScore}`, actual: answer.score });
      }
      if (gates.maxScore !== undefined && answer.score > gates.maxScore) {
        failures.push({ question: id, check: "max-score", expected: `<= ${gates.maxScore}`, actual: answer.score });
      }
    }
  }

  return failures;
}

/** Throw the exit-6 error when any gate failed. Results are already printed by then. */
export function enforceGates(answers: Record<string, Answer>, gates: GateOptions): void {
  if (!hasGates(gates)) return;
  const failures = evaluateGates(answers, gates);
  if (failures.length === 0) return;
  const summary = failures
    .map((f) => `${f.question} ${f.check} expected ${f.expected}, got ${f.actual}`)
    .join("; ");
  throw gateError(`Gate not met: ${summary}`, { failures });
}
