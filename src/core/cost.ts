import type { Usage } from "@typesafe-ai/sdk";

/**
 * Jev pricing in US dollars per million tokens, hand-copied from
 * https://docs.typesafe.ai/models. Output tokens are free, which is why adding
 * questions to a request is nearly free while re-sending state is not.
 *
 * This is a local guess, not a quote. Nothing checks it against the live price list,
 * so it silently goes stale whenever TypeSafe changes a rate. Every figure derived
 * from it is an estimate for ordering runs by rough magnitude; the invoice decides.
 */
export const PRICE_PER_MTOK = { input: 0.042, output: 0.0 } as const;

export interface CostSummary {
  input_tokens: number;
  output_tokens: number;
  /** Cost in US dollars. */
  usd: number;
  /** Number of billed API requests this summary covers. */
  requests: number;
}

export const emptyCost = (): CostSummary => ({
  input_tokens: 0,
  output_tokens: 0,
  usd: 0,
  requests: 0,
});

export function costOf(usage: Usage): number {
  return (
    (usage.input_tokens / 1e6) * PRICE_PER_MTOK.input +
    (usage.output_tokens / 1e6) * PRICE_PER_MTOK.output
  );
}

/** Accumulate usage across the many requests a recipe may fire. */
export function addUsage(total: CostSummary, usage: Usage, requests = 1): CostSummary {
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  total.usd += costOf(usage);
  total.requests += requests;
  return total;
}

/**
 * Format a dollar amount for display. Single calls cost fractions of a cent, so a
 * fixed 2-decimal format would render everything as $0.00.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(4)}`;
}
