import type { ChoiceCriteria, Questions } from "@typesafe-ai/sdk";
import type { Answer } from "../../core/client.ts";
import { formatUsd } from "../../core/cost.ts";
import { gateError, usageError } from "../../core/exit.ts";
import { Painter, bar, printField, printJson, writeLine } from "../../render/output.ts";
import type { CommandSpec } from "../../router.ts";
import { STATE_FLAGS, bool, clip, list, loadState, makeRunner, num, outputFrom, probability, str } from "../common.ts";

const VERDICTS: ChoiceCriteria = {
  supports: "The source states this, or states something that directly entails it.",
  contradicts: "The source states something incompatible with this claim.",
  says_nothing: "The source neither supports nor contradicts it. It is silent on the point.",
};

/** Collapse whitespace and case so a quote match is not defeated by re-wrapping. */
const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Quoted spans inside a claim, which are the parts that must appear verbatim. */
export function quotedSpans(claim: string): string[] {
  const spans: string[] = [];
  const pattern = /"([^"]{4,})"|“([^”]{4,})”/g;
  for (;;) {
    const match = pattern.exec(claim);
    if (!match) break;
    const span = match[1] ?? match[2];
    if (span) spans.push(span);
  }
  return spans;
}

export const verify: CommandSpec = {
  name: "verify",
  group: "Recipes",
  summary: "Check claims against a source document",
  args: "[file...]",
  description: `
Judges each claim as supports, contradicts, or says_nothing against the source.

Every claim is asked against the same source in one request, so checking ten claims
costs one call. A claim that is quoted, with the quoted span in double quotes, is
first checked in code for a verbatim match: a fabricated quote is caught without
spending anything on it, and the result is reported as quote_found.

says_nothing is a real verdict, not a failure. Treat a source that is silent
differently from one that disagrees.
`,
  flags: {
    ...STATE_FLAGS,
    claim: { type: "string", short: "t", multiple: true, value: "<text>", description: "A claim to check, repeatable" },
    "min-confidence": {
      type: "number",
      value: "<0-1>",
      description: "Exit 6 when any verdict is less confident than this",
    },
    require: {
      type: "string",
      value: "<verdict>",
      choices: ["supports", "contradicts", "says_nothing"],
      description: "Exit 6 unless every claim gets this verdict",
    },
    "max-chars": { type: "number", value: "<n>", description: "Truncate the source", default: "40000" },
  },
  examples: [
    `tsai verify -t "The timeout defaults to 60 seconds" -t 'The docs say "retries are disabled by default"' README.md`,
    `tsai verify --state "$ANSWER_CLAIMS" --state-file source.md --require supports`,
    `tsai verify -t "This endpoint requires authentication" api.md --field claims.0.verdict`,
  ],
  async run({ flags, positionals }) {
    const mode = outputFrom(flags);
    const runner = makeRunner(flags);
    const claims = list(flags, "claim");
    if (claims.length === 0) {
      throw usageError("No claims to check.", 'Repeat -t "<claim>" for each statement to verify.');
    }

    const source = await loadState(flags, positionals);
    const sourceText = typeof source === "string" ? source : JSON.stringify(source);
    const normalizedSource = normalize(sourceText);

    const quoteChecks = claims.map((claim) => {
      const spans = quotedSpans(claim);
      if (spans.length === 0) return undefined;
      return spans.every((span) => normalizedSource.includes(normalize(span)));
    });

    const questions: Questions = {};
    claims.forEach((claim, index) => {
      questions[`c${index}`] = {
        type: "choice",
        instructions: {
          task: "Judge the claim against `source`. Use only what `source` states; do not use outside knowledge.",
          claim,
        },
        criteria: VERDICTS,
      };
    });

    const payload = runner.buildPayload(
      { source: clip(sourceText, num(flags, "max-chars") ?? 40000) },
      questions,
      str(flags, "model"),
    );
    if (bool(flags, "dry-run")) {
      printJson({ dry_run: true, body: payload }, mode);
      return;
    }

    const response = await runner.systemOne(payload);
    const results = claims.map((claim, index) => {
      const answer = response.answers[`c${index}`] as Answer | undefined;
      const verdict = answer && answer.type === "choice" ? answer.choice : "says_nothing";
      const confidence = answer && answer.type === "choice" ? answer.confidence : 0;
      const probabilities = answer && answer.type === "choice" ? answer.probabilities : {};
      return {
        claim,
        verdict,
        confidence,
        probabilities,
        ...(quoteChecks[index] !== undefined ? { quote_found: quoteChecks[index] } : {}),
      };
    });

    const document = {
      claims: results,
      source_chars: sourceText.length,
      model: response.model,
      usage: response.usage,
      cached: response.cached,
    };

    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) printJson(document, mode);
    else {
      const paint = new Painter(mode.color);
      writeLine("");
      for (const result of results) {
        const badge =
          result.verdict === "supports"
            ? paint.green("supports    ")
            : result.verdict === "contradicts"
              ? paint.red("contradicts ")
              : paint.yellow("says nothing");
        writeLine(`  ${badge} ${paint.dim(`conf ${result.confidence.toFixed(2)}`)} ${paint.dim(bar(result.confidence, 8))}`);
        writeLine(`    ${result.claim.slice(0, 110)}`);
        if (result.quote_found === false) {
          writeLine(`    ${paint.red("quoted text does not appear verbatim in the source")}`);
        }
        writeLine("");
      }
      if (!mode.quiet) {
        writeLine(paint.dim(`  ${response.model} · ${claims.length} claims in 1 request · ${formatUsd(runner.cost.usd)}`));
      }
    }

    const fabricated = results.filter((result) => result.quote_found === false);
    if (fabricated.length > 0) {
      throw gateError(`${fabricated.length} quoted claim(s) do not appear verbatim in the source.`, {
        claims: fabricated.map((result) => result.claim),
      });
    }

    const requiredVerdict = str(flags, "require");
    if (requiredVerdict) {
      const wrong = results.filter((result) => result.verdict !== requiredVerdict);
      if (wrong.length > 0) {
        throw gateError(`${wrong.length} claim(s) did not get the verdict "${requiredVerdict}".`, {
          claims: wrong.map((result) => ({ claim: result.claim, verdict: result.verdict })),
        });
      }
    }

    const minConfidence = num(flags, "min-confidence");
    if (minConfidence !== undefined) {
      probability(flags, "min-confidence", 0);
      const unsure = results.filter((result) => result.confidence < minConfidence);
      if (unsure.length > 0) {
        throw gateError(`${unsure.length} verdict(s) fell below confidence ${minConfidence}.`, {
          claims: unsure.map((result) => ({ claim: result.claim, confidence: result.confidence })),
        });
      }
    }
  },
};
