import { describe, expect, test } from "bun:test";
import { cacheKey } from "../src/core/cache.ts";
import { addUsage, costOf, emptyCost, formatUsd, PRICE_PER_MTOK } from "../src/core/cost.ts";

describe("cacheKey", () => {
  const base = "https://api.typesafe.ai";
  const payload = { model: "jev-latest", state: "hello", questions: { a: { type: "noul" } } };

  test("the same payload yields the same key across calls", () => {
    expect(cacheKey(payload, base)).toBe(cacheKey(payload, base));
  });

  test("key insertion order does not change the hash", () => {
    const reordered = { questions: { a: { type: "noul" } }, state: "hello", model: "jev-latest" };
    expect(cacheKey(reordered, base)).toBe(cacheKey(payload, base));
  });

  test("nested key order does not change the hash either", () => {
    const a = { q: { one: { type: "noul", instructions: "x" } } };
    const b = { q: { one: { instructions: "x", type: "noul" } } };
    expect(cacheKey(a, base)).toBe(cacheKey(b, base));
  });

  test("a changed state is a different key, so a stale hit is impossible", () => {
    expect(cacheKey({ ...payload, state: "goodbye" }, base)).not.toBe(cacheKey(payload, base));
  });

  test("a changed model is a different key", () => {
    expect(cacheKey({ ...payload, model: "jev-preview" }, base)).not.toBe(cacheKey(payload, base));
  });

  test("the base URL is part of the key, so two hosts never share entries", () => {
    expect(cacheKey(payload, "https://staging.typesafe.ai")).not.toBe(cacheKey(payload, base));
  });

  test("array order is significant, unlike object key order", () => {
    expect(cacheKey({ c: ["a", "b"] }, base)).not.toBe(cacheKey({ c: ["b", "a"] }, base));
  });

  test("an undefined property is ignored, matching what JSON would send", () => {
    expect(cacheKey({ a: 1, b: undefined }, base)).toBe(cacheKey({ a: 1 }, base));
  });

  test("the key is a hex sha256 digest", () => {
    expect(cacheKey(payload, base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cost", () => {
  test("output tokens are free, so only input tokens are billed", () => {
    expect(PRICE_PER_MTOK.output).toBe(0);
    expect(costOf({ input_tokens: 1_000_000, output_tokens: 9_999_999 })).toBeCloseTo(0.042, 10);
  });

  test("a million input tokens costs the published rate", () => {
    expect(costOf({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(0.042, 10);
  });

  test("a typical single request costs a small fraction of a cent", () => {
    const usd = costOf({ input_tokens: 281, output_tokens: 20 });
    expect(usd).toBeGreaterThan(0);
    expect(usd).toBeLessThan(0.0001);
  });

  test("zero usage costs nothing", () => {
    expect(costOf({ input_tokens: 0, output_tokens: 0 })).toBe(0);
  });

  test("addUsage accumulates tokens, dollars and the request count", () => {
    const total = emptyCost();
    addUsage(total, { input_tokens: 100, output_tokens: 10 });
    addUsage(total, { input_tokens: 200, output_tokens: 20 });
    expect(total.input_tokens).toBe(300);
    expect(total.output_tokens).toBe(30);
    expect(total.requests).toBe(2);
    expect(total.usd).toBeCloseTo(costOf({ input_tokens: 300, output_tokens: 30 }), 12);
  });

  test("addUsage can record a batch as many requests at once", () => {
    const total = emptyCost();
    addUsage(total, { input_tokens: 500, output_tokens: 0 }, 7);
    expect(total.requests).toBe(7);
  });

  test("formatUsd keeps sub-cent amounts legible instead of rounding them to zero", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0000118)).toBe("$0.000012");
    expect(formatUsd(0.5)).toBe("$0.5000");
  });
});
