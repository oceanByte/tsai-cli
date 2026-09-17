import type { ChoiceCriteria } from "@typesafe-ai/sdk";
import { formatUsd } from "../../core/cost.ts";
import { gateError, usageError } from "../../core/exit.ts";
import { LIMITS } from "../../core/validate.ts";
import { Painter, bar, printField, printJson, writeLine } from "../../render/output.ts";
import type { CommandSpec } from "../../router.ts";
import { STATE_FLAGS, bool, clip, list, loadState, makeRunner, num, outputFrom, required, str } from "../common.ts";

/**
 * Named patterns for the values people usually want out of a file.
 *
 * Extraction is done as selection, not generation: code finds every candidate with a
 * regex, the model picks which one was meant, and the winning substring is copied
 * verbatim. A value the regex never matched cannot be returned, which is why the
 * candidate list is reported alongside the answer.
 */
export const PATTERNS: Record<string, RegExp> = {
  email: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  url: /https?:\/\/[^\s"'<>)\]]+/g,
  semver: /\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  number: /-?\b\d[\d,]*(?:\.\d+)?\b/g,
  money: /[$€£]\s?\d[\d,]*(?:\.\d{2})?/g,
  date: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  path: /(?:[\w.-]+\/)+[\w.-]+/g,
  duration: /\b\d+\s?(?:ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hours|d|days)\b/gi,
};

interface Match {
  value: string;
  /** Offset of the first occurrence, used to show the line it came from. */
  index: number;
}

/** Collect distinct matches in first-seen order, so the list is stable across runs. */
export function collect(text: string, patterns: readonly RegExp[], maxValueChars: number): Match[] {
  const seen = new Map<string, Match>();
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (;;) {
      const found = global.exec(text);
      if (!found) break;
      if (found[0] === "") {
        global.lastIndex += 1;
        continue;
      }
      const value = found[0].trim();
      if (value === "" || value.length > maxValueChars) continue;
      if (!seen.has(value)) seen.set(value, { value, index: found.index });
    }
  }
  return [...seen.values()];
}

/** The line a match sits on, so two similar values can be told apart. */
function contextFor(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 160);
}

export const extract: CommandSpec = {
  name: "extract",
  group: "Recipes",
  summary: "Pull a specific value out of text by selecting, not generating",
  args: "[file...]",
  description: `
Code finds every candidate value with a regex, the model picks the one that matches
--want, and the winning substring is copied out verbatim. Nothing is retyped, so the
result cannot drift from what the source actually says.

Use --preset for a built-in pattern (${Object.keys(PATTERNS).join(", ")}) or --pattern
for your own regex. Both are repeatable and combine.

A "none" option is always offered. If it wins, the answer is that no candidate was
the value asked for, which is different from the regex finding nothing at all.
`,
  flags: {
    ...STATE_FLAGS,
    want: { type: "string", short: "t", value: "<text>", description: "Which value is wanted" },
    preset: {
      type: "string",
      multiple: true,
      value: "<name>",
      description: `A built-in pattern: ${Object.keys(PATTERNS).join(", ")}`,
    },
    pattern: { type: "string", multiple: true, value: "<regex>", description: "A custom JavaScript regex, repeatable" },
    all: { type: "boolean", description: "Report every candidate with its probability" },
    require: { type: "boolean", description: "Exit 6 when no candidate is selected" },
    "max-value-chars": { type: "number", value: "<n>", description: "Ignore matches longer than this", default: "200" },
    "max-chars": { type: "number", value: "<n>", description: "Truncate the source", default: "40000" },
  },
  examples: [
    `tsai extract -t "the production database host" --preset url config/*.yml`,
    `tsai extract -t "the version this release ships" --preset semver CHANGELOG.md --field value`,
    `tsai extract -t "the on-call contact" --pattern '[\\w.]+@[\\w.]+' --all runbook.md`,
  ],
  async run({ flags, positionals }) {
    const want = required(flags, "want", 'Example: -t "the API base URL used in production"');
    const mode = outputFrom(flags);
    const runner = makeRunner(flags);

    const patterns: RegExp[] = [];
    for (const name of list(flags, "preset")) {
      const pattern = PATTERNS[name];
      if (!pattern) {
        throw usageError(`Unknown preset "${name}".`, `Available: ${Object.keys(PATTERNS).join(", ")}.`);
      }
      patterns.push(pattern);
    }
    for (const source of list(flags, "pattern")) {
      try {
        patterns.push(new RegExp(source, "g"));
      } catch (error) {
        throw usageError(`--pattern ${source} is not a valid regex: ${error instanceof Error ? error.message : ""}`);
      }
    }
    if (patterns.length === 0) {
      throw usageError(
        "No patterns supplied.",
        `Pass --preset <${Object.keys(PATTERNS).slice(0, 3).join("|")}|...> or --pattern <regex>.`,
      );
    }

    const state = await loadState(flags, positionals);
    const text = clip(typeof state === "string" ? state : JSON.stringify(state, null, 2), num(flags, "max-chars") ?? 40000);
    const matches = collect(text, patterns, num(flags, "max-value-chars") ?? 200);

    if (matches.length === 0) {
      const document = { value: null, reason: "no_candidates", want, candidates: [] };
      if (mode.field) return printField(document, mode.field);
      if (!mode.pretty) printJson(document, mode);
      else writeLine(`\n  ${new Painter(mode.color).yellow("no candidates matched the pattern")}\n`);
      if (bool(flags, "require")) throw gateError("No candidate values were found in the source.", { want });
      return;
    }

    // Leave one slot for the escape option.
    const capped = matches.slice(0, LIMITS.MAX_CHOICE_OPTIONS - 1);
    const criteria: ChoiceCriteria = {};
    for (const match of capped) criteria[match.value] = `Appears in: ${contextFor(text, match.index)}`;
    criteria.none = "None of these is the value being asked for.";

    const payload = runner.buildPayload(
      { source: text, wanted: want },
      {
        value: {
          type: "choice",
          instructions:
            "Which of these values, all copied verbatim out of `source`, is the one described by `wanted`? Each option shows the line it was found on.",
          criteria,
        },
      },
      str(flags, "model"),
    );
    if (bool(flags, "dry-run")) return printJson({ dry_run: true, body: payload }, mode);

    const response = await runner.systemOne(payload);
    const answer = response.answers.value;
    const choice = answer && answer.type === "choice" ? answer.choice : "none";
    const confidence = answer && answer.type === "choice" ? answer.confidence : 0;
    const probabilities = answer && answer.type === "choice" ? answer.probabilities : {};

    const ranked = Object.entries(probabilities)
      .filter(([label]) => label !== "none")
      .sort(([, a], [, b]) => b - a)
      .map(([value, probability]) => ({ value, probability }));

    const document = {
      value: choice === "none" ? null : choice,
      ...(choice === "none" ? { reason: "no_candidate_matched" } : {}),
      want,
      confidence,
      candidates_found: matches.length,
      ...(matches.length > capped.length ? { candidates_truncated: matches.length - capped.length } : {}),
      none_probability: probabilities.none ?? 0,
      ...(bool(flags, "all") ? { candidates: ranked } : {}),
      model: response.model,
      usage: response.usage,
      cached: response.cached,
    };

    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) printJson(document, mode);
    else {
      const paint = new Painter(mode.color);
      writeLine("");
      if (choice === "none") writeLine(`  ${paint.yellow("none")} ${paint.dim("of the candidates is the value asked for")}`);
      else writeLine(`  ${paint.cyan(choice)}  ${paint.dim(`conf ${confidence.toFixed(2)}`)}`);
      if (bool(flags, "all")) {
        writeLine("");
        for (const entry of ranked.slice(0, 15)) {
          writeLine(
            `    ${paint.byStrength(entry.probability, entry.probability.toFixed(2))} ${paint.dim(bar(entry.probability, 8))}  ${entry.value.slice(0, 80)}`,
          );
        }
      }
      writeLine("");
      if (!mode.quiet) {
        writeLine(paint.dim(`  ${matches.length} candidates · ${response.model} · ${formatUsd(runner.cost.usd)}`));
      }
    }

    if (bool(flags, "require") && choice === "none") {
      throw gateError("No candidate was selected as the requested value.", { want, candidates: matches.length });
    }
  },
};
