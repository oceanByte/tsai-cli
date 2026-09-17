import { describe, expect, test } from "bun:test";
import type { Answer } from "../src/core/client.ts";
import { CliError, EXIT } from "../src/core/exit.ts";
import { enforceGates, evaluateGates, hasGates, validateGates } from "../src/core/gate.ts";

const noul = (value: number): Answer => ({ type: "noul", noul: value }) as Answer;
const choice = (label: string, confidence: number): Answer =>
  ({ type: "choice", choice: label, confidence, probabilities: { [label]: confidence } }) as Answer;
const score = (value: number, confidence: number): Answer =>
  ({ type: "score", score: value, confidence, legend: { 0: "low", 1: "high" }, probabilities: {} }) as Answer;

const codeOf = (run: () => void): number | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof CliError ? error.code : EXIT.INTERNAL;
  }
};

describe("hasGates", () => {
  test("an empty option bag means no gating", () => {
    expect(hasGates({})).toBe(false);
  });
  test("any single option turns gating on", () => {
    expect(hasGates({ maxNoul: 0.5 })).toBe(true);
    expect(hasGates({ expect: "bug" })).toBe(true);
  });
});

describe("validateGates", () => {
  test("min-confidence against noul-only questions is a usage error", () => {
    expect(codeOf(() => validateGates({ minConfidence: 0.8 }, new Set(["noul"])))).toBe(EXIT.USAGE);
  });

  test("min-confidence is allowed when a choice or score is present", () => {
    expect(() => validateGates({ minConfidence: 0.8 }, new Set(["noul", "choice"]))).not.toThrow();
    expect(() => validateGates({ minConfidence: 0.8 }, new Set(["score"]))).not.toThrow();
  });

  test("noul gates require a noul question", () => {
    expect(codeOf(() => validateGates({ minNoul: 0.5 }, new Set(["choice"])))).toBe(EXIT.USAGE);
  });

  test("expect requires a choice question", () => {
    expect(codeOf(() => validateGates({ expect: "bug" }, new Set(["noul"])))).toBe(EXIT.USAGE);
  });

  test("score gates require a score question", () => {
    expect(codeOf(() => validateGates({ minScore: 2 }, new Set(["noul"])))).toBe(EXIT.USAGE);
  });

  test("a probability outside 0 to 1 is rejected", () => {
    expect(codeOf(() => validateGates({ minNoul: 1.5 }, new Set(["noul"])))).toBe(EXIT.USAGE);
    expect(codeOf(() => validateGates({ minConfidence: -0.1 }, new Set(["choice"])))).toBe(EXIT.USAGE);
  });

  test("an inverted noul range is rejected", () => {
    expect(codeOf(() => validateGates({ minNoul: 0.9, maxNoul: 0.1 }, new Set(["noul"])))).toBe(EXIT.USAGE);
  });

  test("an unknown question type set skips the applicability checks", () => {
    expect(() => validateGates({ expect: "bug" }, new Set())).not.toThrow();
  });
});

describe("evaluateGates", () => {
  test("a satisfied gate produces no failures", () => {
    expect(evaluateGates({ a: noul(0.9) }, { minNoul: 0.8 })).toEqual([]);
  });

  test("a noul below the floor fails and reports the observed value", () => {
    const failures = evaluateGates({ a: noul(0.2) }, { minNoul: 0.8 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ question: "a", check: "min-noul", actual: 0.2 });
  });

  test("a noul above the ceiling fails", () => {
    expect(evaluateGates({ a: noul(0.9) }, { maxNoul: 0.3 })[0]?.check).toBe("max-noul");
  });

  test("a noul is never checked for confidence, which it does not carry", () => {
    expect(evaluateGates({ a: noul(0.9) }, { minConfidence: 0.99 })).toEqual([]);
  });

  test("a wrong choice label fails with both expected and actual", () => {
    const failures = evaluateGates({ team: choice("frontend", 1) }, { expect: "backend" });
    expect(failures[0]).toMatchObject({ check: "expect", expected: "backend", actual: "frontend" });
  });

  test("score bounds are checked in both directions", () => {
    expect(evaluateGates({ s: score(1.2, 0.9) }, { minScore: 2 })[0]?.check).toBe("min-score");
    expect(evaluateGates({ s: score(3.4, 0.9) }, { maxScore: 2 })[0]?.check).toBe("max-score");
  });

  test("every failure across every answer is collected, not just the first", () => {
    const failures = evaluateGates(
      { a: noul(0.1), team: choice("frontend", 0.4) },
      { minNoul: 0.8, expect: "backend", minConfidence: 0.9 },
    );
    expect(failures.map((f) => f.check).sort()).toEqual(["expect", "min-confidence", "min-noul"]);
  });

  test("boundaries are inclusive, so an exact match passes", () => {
    expect(evaluateGates({ a: noul(0.8) }, { minNoul: 0.8, maxNoul: 0.8 })).toEqual([]);
    expect(evaluateGates({ s: score(2, 0.5) }, { minScore: 2, maxScore: 2 })).toEqual([]);
  });
});

describe("enforceGates", () => {
  test("no gates configured means nothing is thrown", () => {
    expect(() => enforceGates({ a: noul(0) }, {})).not.toThrow();
  });

  test("a failure throws exit 6 carrying the structured failures", () => {
    let thrown: unknown;
    try {
      enforceGates({ a: noul(0.1) }, { minNoul: 0.8 });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as CliError).code).toBe(EXIT.GATE);
    expect((thrown as CliError).details?.failures).toHaveLength(1);
  });
});
