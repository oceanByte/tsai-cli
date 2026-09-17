import { describe, expect, test } from "bun:test";
import { pathScore } from "../src/commands/recipes/classify.ts";
import { collect, PATTERNS } from "../src/commands/recipes/extract.ts";
import { splitByFile, splitByHunk } from "../src/commands/recipes/review.ts";
import { decide } from "../src/commands/recipes/screen.ts";
import { quotedSpans } from "../src/commands/recipes/verify.ts";
import { parseLabelPairs } from "../src/commands/primitives.ts";
import { CliError, EXIT } from "../src/core/exit.ts";

const DIFF = `diff --git a/src/pay.ts b/src/pay.ts
index 1111111..2222222 100644
--- a/src/pay.ts
+++ b/src/pay.ts
@@ -1,3 +1,4 @@
 export function total(items) {
+  console.log(items);
   return items.length;
 }
@@ -20,2 +21,3 @@ export function refund(id) {
+  fetch("/api/refund/" + id);
 }
diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # project
+Now with refunds.
`;

describe("splitByFile", () => {
  test("each file in the diff becomes one part, named by its b-side path", () => {
    const parts = splitByFile(DIFF);
    expect(parts.map((p) => p.path)).toEqual(["src/pay.ts", "README.md"]);
  });

  test("every part keeps the hunk bodies belonging to its file", () => {
    const [pay] = splitByFile(DIFF);
    expect(pay?.diff).toContain("console.log");
    expect(pay?.diff).toContain("fetch(");
    expect(pay?.diff).not.toContain("Now with refunds");
  });

  test("an empty diff produces no parts, so nothing is sent", () => {
    expect(splitByFile("")).toEqual([]);
    expect(splitByFile("   \n  ")).toEqual([]);
  });

  test("a path containing spaces is still recovered", () => {
    const parts = splitByFile('diff --git a/my docs/a b.md b/my docs/a b.md\n@@ -1 +1 @@\n+x\n');
    expect(parts[0]?.path).toBe("my docs/a b.md");
  });
});

describe("splitByHunk", () => {
  test("a two-hunk file becomes two parts while a one-hunk file stays one", () => {
    const parts = splitByHunk(splitByFile(DIFF));
    expect(parts.filter((p) => p.path === "src/pay.ts")).toHaveLength(2);
    expect(parts.filter((p) => p.path === "README.md")).toHaveLength(1);
  });

  test("each hunk part records its own @@ header", () => {
    const hunks = splitByHunk(splitByFile(DIFF)).filter((p) => p.path === "src/pay.ts");
    expect(hunks[0]?.hunk).toContain("@@ -1,3 +1,4 @@");
    expect(hunks[1]?.hunk).toContain("@@ -20,2 +21,3 @@");
  });

  test("hunk splitting never loses or duplicates a changed line", () => {
    const added = (text: string) => (text.match(/^\+[^+]/gm) ?? []).length;
    const whole = splitByFile(DIFF).reduce((n, p) => n + added(p.diff), 0);
    const perHunk = splitByHunk(splitByFile(DIFF)).reduce((n, p) => n + added(p.diff), 0);
    expect(perHunk).toBe(whole);
  });

  test("a part with no hunk header passes through untouched", () => {
    const part = { path: "bin/logo.png", diff: "Binary files differ" };
    expect(splitByHunk([part])).toEqual([part]);
  });
});

describe("quotedSpans", () => {
  test("straight and curly quotes are both recognised", () => {
    expect(quotedSpans('The docs say "retries three times" here.')).toEqual(["retries three times"]);
    expect(quotedSpans("It states “the cache is on by default” clearly.")).toEqual([
      "the cache is on by default",
    ]);
  });

  test("several quoted spans in one claim are all returned, in order", () => {
    expect(quotedSpans('Both "first span" and "second span" appear.')).toEqual(["first span", "second span"]);
  });

  test("a claim with no quotes yields nothing to check verbatim", () => {
    expect(quotedSpans("The timeout is sixty seconds.")).toEqual([]);
  });

  test("a span too short to be a meaningful quote is ignored", () => {
    expect(quotedSpans('The flag is "ok" here.')).toEqual([]);
  });
});

describe("pathScore", () => {
  test("a zero-depth path scores zero rather than dividing by zero", () => {
    expect(pathScore(0, 0)).toBe(0);
  });

  test("a certain path scores 1 at any depth", () => {
    expect(pathScore(Math.log(1) * 3, 3)).toBeCloseTo(1, 12);
  });

  test("scoring is length-normalized, so depth alone does not penalise a path", () => {
    const shallow = pathScore(Math.log(0.5), 1);
    const deep = pathScore(Math.log(0.5) * 4, 4);
    expect(deep).toBeCloseTo(shallow, 12);
  });

  test("a weaker path scores below a stronger one of the same depth", () => {
    expect(pathScore(Math.log(0.9) * 2, 2)).toBeGreaterThan(pathScore(Math.log(0.4) * 2, 2));
  });

  test("the score is the geometric mean of the step probabilities", () => {
    expect(pathScore(Math.log(0.9) + Math.log(0.4), 2)).toBeCloseTo(Math.sqrt(0.9 * 0.4), 12);
  });
});

describe("decide", () => {
  const thresholds = { block: 0.7, review: 0.4, escalate: 2 };

  test("a hazard at or above the block threshold blocks", () => {
    expect(decide(0.7, 0, thresholds).action).toBe("block");
    expect(decide(0.99, 0, thresholds).action).toBe("block");
  });

  test("a hazard in the middle band asks for review", () => {
    expect(decide(0.5, 0, thresholds).action).toBe("review");
    expect(decide(0.4, undefined, thresholds).action).toBe("review");
  });

  test("severity escalates a review to a block", () => {
    expect(decide(0.5, 2, thresholds).action).toBe("block");
    expect(decide(0.5, 1.9, thresholds).action).toBe("review");
  });

  test("severity never escalates something already below the review band", () => {
    expect(decide(0.1, 3, thresholds).action).toBe("pass");
  });

  test("a low hazard passes", () => {
    expect(decide(0.03, undefined, thresholds).action).toBe("pass");
  });

  test("every decision explains itself with the observed number", () => {
    for (const hazard of [0.03, 0.5, 0.9]) {
      expect(decide(hazard, 1, thresholds).reason).toContain(hazard.toFixed(2));
    }
  });
});

describe("collect", () => {
  test("distinct matches are returned in first-seen order", () => {
    const found = collect("ping a@b.com then c@d.org", [PATTERNS.email!], 200);
    expect(found.map((m) => m.value)).toEqual(["a@b.com", "c@d.org"]);
  });

  test("a repeated value is collected once, keeping its first offset", () => {
    const text = "a@b.com and again a@b.com";
    const found = collect(text, [PATTERNS.email!], 200);
    expect(found).toHaveLength(1);
    expect(found[0]?.index).toBe(0);
  });

  test("several patterns are merged into one candidate list", () => {
    const found = collect("v1.2.3 shipped to 10.0.0.1", [PATTERNS.semver!, PATTERNS.ipv4!], 200);
    expect(found.map((m) => m.value)).toContain("v1.2.3");
    expect(found.map((m) => m.value)).toContain("10.0.0.1");
  });

  test("a value longer than the cap is left out rather than truncated", () => {
    const long = `https://example.com/${"x".repeat(300)}`;
    expect(collect(long, [PATTERNS.url!], 50)).toEqual([]);
  });

  test("text with no match yields an empty candidate list", () => {
    expect(collect("nothing to see", [PATTERNS.email!], 200)).toEqual([]);
  });

  test("a non-global pattern is still scanned exhaustively", () => {
    const found = collect("a@b.com and c@d.org", [/[\w.+-]+@[\w-]+\.[\w.-]+/], 200);
    expect(found).toHaveLength(2);
  });

  test("the number pattern does not match a digit separator, which the model cannot then select", () => {
    // A known limit of selection-over-generation: an omitted candidate is unreachable.
    expect(collect("timeout = 60_000", [PATTERNS.number!], 200).map((m) => m.value)).not.toContain("60_000");
  });

  test.each([
    ["email", "write to ops@example.co.uk now", "ops@example.co.uk"],
    ["url", "see https://a.example/x?y=1 for more", "https://a.example/x?y=1"],
    ["semver", "bumped to 10.4.2-beta.1 today", "10.4.2-beta.1"],
    ["uuid", "id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 here", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    ["money", "costs $1,299.00 total", "$1,299.00"],
    ["date", "due 2026-01-31 sharp", "2026-01-31"],
    ["duration", "waits 500 ms before retry", "500 ms"],
    ["path", "edit src/core/config.ts now", "src/core/config.ts"],
  ])("the %s pattern finds its value", (name, text, expected) => {
    expect(collect(text, [PATTERNS[name]!], 200).map((m) => m.value)).toContain(expected);
  });
});

describe("parseLabelPairs", () => {
  test("label=description pairs become criteria", () => {
    expect(parseLabelPairs(["backend=APIs", "frontend=web UI"])).toEqual({
      backend: "APIs",
      frontend: "web UI",
    });
  });

  test("a bare label is accepted with no description", () => {
    expect(parseLabelPairs(["bug", "feature"])).toEqual({ bug: null, feature: null });
  });

  test("a description containing an equals sign is kept whole", () => {
    expect(parseLabelPairs(["eq=a = b"])).toEqual({ eq: "a = b" });
  });

  test("an empty label is a usage error", () => {
    let code: unknown;
    try {
      parseLabelPairs(["=nothing"]);
    } catch (error) {
      code = (error as CliError).code;
    }
    expect(code).toBe(EXIT.USAGE);
  });

  test("a duplicate label is a usage error, since it would silently overwrite", () => {
    let code: unknown;
    try {
      parseLabelPairs(["bug=a", "bug=b"]);
    } catch (error) {
      code = (error as CliError).code;
    }
    expect(code).toBe(EXIT.USAGE);
  });
});
