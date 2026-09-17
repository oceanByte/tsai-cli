import type { Answer, SystemOneResponse } from "../core/client.ts";
import { formatUsd, type CostSummary } from "../core/cost.ts";
import type { NormalizedError } from "../core/errors.ts";
import { usageError } from "../core/exit.ts";

/** How results should be written. Resolved once from the global flags. */
export interface OutputMode {
  /** True when human-readable tables should be used instead of JSON. */
  pretty: boolean;
  color: boolean;
  /** Suppress the trailing usage and cost footer. */
  quiet: boolean;
  /** Dotted path to extract a single bare value instead of printing a document. */
  field?: string;
}

/**
 * Decide the output mode.
 *
 * Adaptive by default: a terminal gets tables, a pipe gets JSON. That makes the same
 * command readable when a person runs it and parseable when an agent runs it, with
 * no flag needed in either case.
 */
export function resolveOutputMode(flags: {
  json?: boolean;
  pretty?: boolean;
  quiet?: boolean;
  field?: string;
}): OutputMode {
  if (flags.json && flags.pretty) throw usageError("--json and --pretty cannot be used together.");
  const isTty = Boolean(process.stdout.isTTY);
  // --field prints one bare value, which is never a table.
  const pretty = flags.field ? false : flags.pretty ? true : flags.json ? false : isTty;
  const color =
    pretty &&
    isTty &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb";
  return {
    pretty,
    color,
    quiet: Boolean(flags.quiet),
    ...(flags.field ? { field: flags.field } : {}),
  };
}

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
} as const;

export class Painter {
  constructor(private readonly on: boolean) {}
  private wrap(code: string, text: string): string {
    return this.on ? `${code}${text}${ANSI.reset}` : text;
  }
  dim = (t: string) => this.wrap(ANSI.dim, t);
  bold = (t: string) => this.wrap(ANSI.bold, t);
  red = (t: string) => this.wrap(ANSI.red, t);
  green = (t: string) => this.wrap(ANSI.green, t);
  yellow = (t: string) => this.wrap(ANSI.yellow, t);
  blue = (t: string) => this.wrap(ANSI.blue, t);
  cyan = (t: string) => this.wrap(ANSI.cyan, t);
  /** Colour a 0-1 probability by strength, so a scan of the output shows the shape. */
  byStrength(value: number, text: string): string {
    if (!this.on) return text;
    if (value >= 0.8) return this.green(text);
    if (value >= 0.5) return this.yellow(text);
    if (value >= 0.2) return text;
    return this.dim(text);
  }
}

/** A 10-cell bar for a 0-1 value. */
export function bar(value: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export const pct = (value: number): string => value.toFixed(2);

/** Extract a dotted path such as `answers.severity.score`, supporting array indices. */
export function extractField(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** Print a single extracted value bare, with no quotes, for shell interpolation. */
export function printField(document: unknown, path: string): void {
  const value = extractField(document, path);
  if (value === undefined) {
    throw usageError(`--field ${path} did not match anything in the result.`);
  }
  writeLine(typeof value === "object" ? JSON.stringify(value) : String(value));
}

/** Emit the result document as JSON, indented only when a person is reading it. */
export function printJson(document: unknown, mode: OutputMode): void {
  writeLine(JSON.stringify(document, null, mode.pretty || process.stdout.isTTY ? 2 : 0));
}

/** Render one answer as an indented block with a probability distribution. */
export function renderAnswer(id: string, answer: Answer, paint: Painter): string[] {
  const lines: string[] = [];

  if (answer.type === "noul") {
    lines.push(
      `  ${paint.bold(id.padEnd(22))} ${paint.byStrength(answer.noul, pct(answer.noul))}  ${paint.dim(
        bar(answer.noul),
      )}  ${paint.dim("p(yes)")}`,
    );
    return lines;
  }

  if (answer.type === "choice") {
    lines.push(
      `  ${paint.bold(id.padEnd(22))} ${paint.cyan(answer.choice)}  ${paint.dim(
        `conf ${pct(answer.confidence)}`,
      )}`,
    );
    const ranked = Object.entries(answer.probabilities).sort(([, a], [, b]) => b - a);
    for (const [label, probability] of ranked) {
      const marker = label === answer.choice ? paint.cyan("›") : " ";
      lines.push(
        `    ${marker} ${label.slice(0, 30).padEnd(31)} ${paint.byStrength(probability, pct(probability))} ${paint.dim(
          bar(probability, 8),
        )}`,
      );
    }
    return lines;
  }

  const top = Math.max(0, Object.keys(answer.legend).length - 1);
  const normalized = top > 0 ? answer.score / top : 0;
  lines.push(
    `  ${paint.bold(id.padEnd(22))} ${paint.cyan(answer.score.toFixed(2))}  ${paint.dim(
      bar(normalized),
    )}  ${paint.dim(`conf ${pct(answer.confidence)}`)}`,
  );
  for (const [index, description] of Object.entries(answer.legend)) {
    const probability = answer.probabilities[index] ?? 0;
    const text = typeof description === "string" ? description : JSON.stringify(description);
    lines.push(
      `    ${paint.dim(index)} ${text.slice(0, 44).padEnd(45)} ${paint.byStrength(
        probability,
        pct(probability),
      )} ${paint.dim(bar(probability, 8))}`,
    );
  }
  return lines;
}

/** The trailing line reporting which model answered and what it cost. */
export function usageFooter(
  response: { model: string; cached: boolean; requestId?: string },
  cost: CostSummary,
  paint: Painter,
): string {
  if (response.cached) {
    return paint.dim(`  ${response.model} · cached, no tokens billed`);
  }
  const parts = [
    response.model,
    `${cost.input_tokens} in / ${cost.output_tokens} out`,
    formatUsd(cost.usd),
  ];
  return paint.dim(`  ${parts.join(" · ")}`);
}

export function printResponse(response: SystemOneResponse, cost: CostSummary, mode: OutputMode): void {
  const document = {
    model: response.model,
    answers: response.answers,
    usage: response.usage,
    ...(response.requestId ? { request_id: response.requestId } : {}),
    cached: response.cached,
  };

  if (mode.field) return printField(document, mode.field);
  if (!mode.pretty) return printJson(document, mode);

  const paint = new Painter(mode.color);
  writeLine("");
  for (const [id, answer] of Object.entries(response.answers)) {
    for (const line of renderAnswer(id, answer, paint)) writeLine(line);
    writeLine("");
  }
  if (!mode.quiet) writeLine(usageFooter(response, cost, paint));
}

/** Render a failure to stderr in whichever format the caller asked for. */
export function printError(error: NormalizedError, mode: OutputMode): void {
  if (!mode.pretty) {
    process.stderr.write(`${JSON.stringify({ error }, null, process.stderr.isTTY ? 2 : 0)}\n`);
    return;
  }
  const paint = new Painter(mode.color && Boolean(process.stderr.isTTY));
  process.stderr.write(`${paint.red("error")} ${error.message}\n`);
  if (error.issues) {
    for (const issue of error.issues) {
      process.stderr.write(`  ${paint.dim(issue.path)} ${issue.message}\n`);
    }
  }
  if (error.hint) process.stderr.write(`${paint.dim(`hint: ${error.hint}`)}\n`);
  if (error.request_id) process.stderr.write(`${paint.dim(`request id: ${error.request_id}`)}\n`);
}
