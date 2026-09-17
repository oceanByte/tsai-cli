import { describe, expect, test } from "bun:test";
import type { Questions } from "@typesafe-ai/sdk";
import { CliError, EXIT } from "../src/core/exit.ts";
import { LIMITS, validateQuestions, validateState } from "../src/core/validate.ts";

const choiceWith = (count: number): Questions => ({
  pick: {
    type: "choice",
    instructions: "Pick one.",
    criteria: Object.fromEntries(Array.from({ length: count }, (_, i) => [`opt${i}`, null])),
  },
}) as unknown as Questions;

const scoreWith = (levels: number): Questions => ({
  rate: {
    type: "score",
    instructions: "Rate it.",
    criteria: Array.from({ length: levels }, (_, i) => `level ${i}`),
  },
}) as unknown as Questions;

/** Assert the thrown value is a usage error, so nothing would have been billed. */
function expectUsageError(run: () => void, fragment: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliError);
  expect((thrown as CliError).code).toBe(EXIT.USAGE);
  expect((thrown as CliError).message).toContain(fragment);
}

describe("validateQuestions", () => {
  test("an empty set is rejected", () => {
    expectUsageError(() => validateQuestions({} as Questions), "No questions supplied");
  });

  test("an unknown question type is rejected by name", () => {
    expectUsageError(
      () => validateQuestions({ q: { type: "bounding_box", instructions: "x" } } as unknown as Questions),
      'unknown type "bounding_box"',
    );
  });

  test("a choice at the 255-option limit is accepted", () => {
    expect(() => validateQuestions(choiceWith(LIMITS.MAX_CHOICE_OPTIONS))).not.toThrow();
  });

  test("a choice one option over the limit is rejected locally", () => {
    expectUsageError(() => validateQuestions(choiceWith(LIMITS.MAX_CHOICE_OPTIONS + 1)), "256 options");
  });

  test("a single-option choice is rejected even though the API accepts it", () => {
    expectUsageError(() => validateQuestions(choiceWith(1)), "only one option");
  });

  test("a choice with no options is rejected", () => {
    expectUsageError(() => validateQuestions(choiceWith(0)), "no options");
  });

  test("score levels are accepted across the whole 2-to-10 range", () => {
    for (let levels = LIMITS.MIN_SCORE_LEVELS; levels <= LIMITS.MAX_SCORE_LEVELS; levels += 1) {
      expect(() => validateQuestions(scoreWith(levels))).not.toThrow();
    }
  });

  test("fewer than two score levels is rejected", () => {
    expectUsageError(() => validateQuestions(scoreWith(1)), "1 level(s)");
  });

  test("more than ten score levels is rejected", () => {
    expectUsageError(() => validateQuestions(scoreWith(11)), "11 levels");
  });

  test("score criteria given as an object rather than an ordered array is rejected", () => {
    expectUsageError(
      () => validateQuestions({ r: { type: "score", instructions: "x", criteria: { a: 1 } } } as unknown as Questions),
      "ordered array",
    );
  });

  test("noul criteria may only use the true and false keys", () => {
    expectUsageError(
      () =>
        validateQuestions({
          n: { type: "noul", instructions: "x", criteria: { true: "a", maybe: "b" } },
        } as unknown as Questions),
      "unexpected key(s): maybe",
    );
  });

  test("noul criteria with only true and false is accepted, as is none at all", () => {
    expect(() =>
      validateQuestions({ n: { type: "noul", instructions: "x", criteria: { true: "a", false: "b" } } } as unknown as Questions),
    ).not.toThrow();
    expect(() => validateQuestions({ n: { type: "noul", instructions: "x" } } as unknown as Questions)).not.toThrow();
  });
});

describe("validateState", () => {
  test("a non-empty string, object or array is accepted", () => {
    expect(() => validateState("hello")).not.toThrow();
    expect(() => validateState({ ticket: "x" })).not.toThrow();
    expect(() => validateState(["a"])).not.toThrow();
  });

  test("null, whitespace, an empty object and an empty array are all rejected", () => {
    expectUsageError(() => validateState(null), "No state supplied");
    expectUsageError(() => validateState("   \n "), "State is empty");
    expectUsageError(() => validateState({}), "State object is empty");
    expectUsageError(() => validateState([]), "State array is empty");
  });
});
