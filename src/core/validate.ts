import type { Question, Questions } from "@typesafe-ai/sdk";
import { usageError } from "./exit.ts";

/**
 * Server-enforced limits, confirmed against the live API rather than the docs.
 * Exceeding either returns HTTP 400, so checking locally saves a round trip.
 */
export const LIMITS = {
  /** `Too many choices. Must have at most 255 choices.` */
  MAX_CHOICE_OPTIONS: 255,
  /** `Too many score levels. Must have at most 10 levels.` */
  MAX_SCORE_LEVELS: 10,
  /** The SDK rejects fewer than two before the request is sent. */
  MIN_SCORE_LEVELS: 2,
} as const;

const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

/**
 * Validate a question set before spending anything on it.
 *
 * Deliberately stricter than the server in two places: a choice with a single option
 * is accepted by the API but is always answered with probability 1.0, which is never
 * what the caller meant; and an empty criteria map produces an unanswerable question.
 */
export function validateQuestions(questions: Questions): void {
  const ids = Object.keys(questions);
  if (ids.length === 0) {
    throw usageError(
      "No questions supplied.",
      "Pass --questions <file.json>, repeat -q '<json>', or use the noul/choice/score shorthands.",
    );
  }

  for (const id of ids) {
    const q = questions[id] as Question | undefined;
    if (!q || typeof q !== "object") {
      throw usageError(`Question "${id}" is not an object.`);
    }
    if (!QUESTION_TYPES.has(q.type)) {
      throw usageError(
        `Question "${id}" has unknown type "${(q as { type: string }).type}".`,
        "Valid types are: noul, choice, score.",
      );
    }

    if (q.type === "choice") {
      const criteria = q.criteria;
      if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
        throw usageError(`Choice question "${id}" needs a criteria object mapping options to descriptions.`);
      }
      const options = Object.keys(criteria);
      if (options.length === 0) {
        throw usageError(`Choice question "${id}" has no options.`);
      }
      if (options.length === 1) {
        throw usageError(
          `Choice question "${id}" has only one option ("${options[0]}").`,
          "A single-option choice is always answered with probability 1.0. Add at least one alternative, or a 'none' escape option.",
        );
      }
      if (options.length > LIMITS.MAX_CHOICE_OPTIONS) {
        throw usageError(
          `Choice question "${id}" has ${options.length} options; the API accepts at most ${LIMITS.MAX_CHOICE_OPTIONS}.`,
          "Split the options across two passes: one question selects a window, a second ranks within it.",
        );
      }
    }

    if (q.type === "score") {
      const criteria = q.criteria;
      if (!Array.isArray(criteria)) {
        throw usageError(`Score question "${id}" needs criteria as an ordered array of level descriptions.`);
      }
      if (criteria.length < LIMITS.MIN_SCORE_LEVELS) {
        throw usageError(
          `Score question "${id}" has ${criteria.length} level(s); at least ${LIMITS.MIN_SCORE_LEVELS} are required.`,
        );
      }
      if (criteria.length > LIMITS.MAX_SCORE_LEVELS) {
        throw usageError(
          `Score question "${id}" has ${criteria.length} levels; the API accepts at most ${LIMITS.MAX_SCORE_LEVELS}.`,
          "Collapse adjacent levels, or split the judgment into two score questions.",
        );
      }
    }

    if (q.type === "noul" && q.criteria != null) {
      const criteria = q.criteria as Record<string, unknown>;
      if (typeof criteria !== "object" || Array.isArray(criteria)) {
        throw usageError(`Noul question "${id}" criteria must be an object with "true" and/or "false" keys.`);
      }
      const extra = Object.keys(criteria).filter((k) => k !== "true" && k !== "false");
      if (extra.length > 0) {
        throw usageError(
          `Noul question "${id}" criteria has unexpected key(s): ${extra.join(", ")}.`,
          'Only "true" and "false" are accepted.',
        );
      }
    }
  }
}

/** Reject state that would produce a meaningless judgment. */
export function validateState(state: unknown): void {
  if (state == null) throw usageError("No state supplied.", "Pass a file path, --state <text>, or pipe text on stdin.");
  if (typeof state === "string" && state.trim() === "") {
    throw usageError("State is empty.", "Pass a file path, --state <text>, or pipe text on stdin.");
  }
  if (Array.isArray(state) && state.length === 0) throw usageError("State array is empty.");
  if (typeof state === "object" && !Array.isArray(state) && Object.keys(state).length === 0) {
    throw usageError("State object is empty.");
  }
}
