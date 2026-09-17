import type { Questions } from "@typesafe-ai/sdk";
import type { Answer } from "../../core/client.ts";
import { formatUsd } from "../../core/cost.ts";
import { gateError, usageError } from "../../core/exit.ts";
import { parseJson } from "../../core/input.ts";
import { Painter, bar, printField, printJson, writeLine } from "../../render/output.ts";
import type { CommandSpec } from "../../router.ts";
import { STATE_FLAGS, loadState, makeRunner, num, outputFrom, probability, str } from "../common.ts";
import builtinPreset from "../../../presets/screen.json" with { type: "json" };
import { readFileSync } from "node:fs";

export type Action = "pass" | "review" | "block";

/**
 * Decide what to do with a screened passage.
 *
 * Two thresholds rather than one, because the useful middle case is "a person or a
 * stronger model should look at this", not a binary accept or reject. Severity
 * escalates a borderline hazard: something only moderately likely, but catastrophic
 * if acted on, belongs in the block bucket rather than the review bucket.
 */
export function decide(
  maxHazard: number,
  severity: number | undefined,
  thresholds: { block: number; review: number; escalate: number },
): { action: Action; reason: string } {
  if (maxHazard >= thresholds.block) {
    return { action: "block", reason: `hazard ${maxHazard.toFixed(2)} at or above the block threshold` };
  }
  if (maxHazard >= thresholds.review) {
    if (severity !== undefined && severity >= thresholds.escalate) {
      return {
        action: "block",
        reason: `hazard ${maxHazard.toFixed(2)} needs review, escalated by severity ${severity.toFixed(2)}`,
      };
    }
    return { action: "review", reason: `hazard ${maxHazard.toFixed(2)} at or above the review threshold` };
  }
  return { action: "pass", reason: `highest hazard ${maxHazard.toFixed(2)} is below the review threshold` };
}

export const screen: CommandSpec = {
  name: "screen",
  group: "Recipes",
  summary: "Screen untrusted text for prompt injection and hazards",
  args: "[file...]",
  description: `
Runs a battery of hazard checks over one passage in a single request, then resolves
them to pass, review, or block.

Intended for text an agent is about to read as data: a fetched web page, a tool
result, an issue body, a dependency README. The passage is placed in a named
\`content\` field so the questions can refer to it as data rather than as instructions.

Every noul in the question set is treated as a hazard and the highest one decides.
A score named "severity" escalates a borderline hazard to block. Supply your own
battery with --preset to change what counts as a hazard.

The default thresholds are starting points, not tuned defaults. Measure them on your
own traffic before trusting them in a gate.
`,
  flags: {
    ...STATE_FLAGS,
    preset: { type: "string", value: "<path>", description: "A custom hazard question set" },
    block: { type: "number", value: "<0-1>", description: "Hazard probability that blocks", default: "0.7" },
    review: { type: "number", value: "<0-1>", description: "Hazard probability that needs review", default: "0.4" },
    escalate: {
      type: "number",
      value: "<n>",
      description: "Severity score that turns a review into a block",
      default: "2",
    },
    "fail-on": {
      type: "string",
      value: "<action>",
      choices: ["block", "review"],
      description: "Exit 6 when the resolved action is this or worse",
    },
  },
  examples: [
    `curl -s https://example.com/readme | tsai screen --fail-on block`,
    `tsai screen issue.txt --field action`,
    `tsai screen --state "$TOOL_OUTPUT" --review 0.3 --json | jq '.triggered'`,
  ],
  async run({ flags, positionals }) {
    const mode = outputFrom(flags);
    const runner = makeRunner(flags);
    const thresholds = {
      block: probability(flags, "block", 0.7),
      review: probability(flags, "review", 0.4),
      escalate: num(flags, "escalate") ?? 2,
    };
    if (thresholds.review > thresholds.block) {
      throw usageError("--review cannot be higher than --block.");
    }

    const presetPath = str(flags, "preset");
    const questions = (
      presetPath ? parseJson(readFileSync(presetPath, "utf8"), presetPath) : builtinPreset
    ) as Questions;

    const content = await loadState(flags, positionals);
    const payload = runner.buildPayload({ content }, questions, str(flags, "model"));
    if (flags["dry-run"] === true) {
      printJson({ dry_run: true, body: payload }, mode);
      return;
    }

    const response = await runner.systemOne(payload);

    const hazards: Array<{ check: string; noul: number }> = [];
    let severity: number | undefined;
    let severityConfidence: number | undefined;

    for (const [id, answer] of Object.entries(response.answers as Record<string, Answer>)) {
      if (answer.type === "noul") hazards.push({ check: id, noul: answer.noul });
      else if (answer.type === "score" && id === "severity") {
        severity = answer.score;
        severityConfidence = answer.confidence;
      }
    }
    if (hazards.length === 0) {
      throw usageError(
        "The question set contains no noul questions, so there is nothing to screen for.",
        "A screening preset needs at least one noul per hazard.",
      );
    }

    hazards.sort((a, b) => b.noul - a.noul);
    const worst = hazards[0] as { check: string; noul: number };
    const { action, reason } = decide(worst.noul, severity, thresholds);
    const triggered = hazards.filter((hazard) => hazard.noul >= thresholds.review);

    const document = {
      action,
      reason,
      thresholds,
      top_hazard: worst,
      ...(severity !== undefined ? { severity, severity_confidence: severityConfidence } : {}),
      triggered,
      hazards,
      model: response.model,
      usage: response.usage,
      cached: response.cached,
    };

    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) printJson(document, mode);
    else {
      const paint = new Painter(mode.color);
      const badge =
        action === "block" ? paint.red("BLOCK") : action === "review" ? paint.yellow("REVIEW") : paint.green("PASS");
      writeLine("");
      writeLine(`  ${badge}  ${paint.dim(reason)}`);
      writeLine("");
      for (const hazard of hazards) {
        writeLine(
          `  ${paint.byStrength(hazard.noul, hazard.noul.toFixed(2))} ${paint.dim(bar(hazard.noul, 8))}  ${hazard.check}`,
        );
      }
      if (severity !== undefined) {
        writeLine("");
        writeLine(`  ${paint.bold("severity")} ${severity.toFixed(2)} ${paint.dim(`(escalates at ${thresholds.escalate})`)}`);
      }
      writeLine("");
      if (!mode.quiet) {
        writeLine(
          paint.dim(
            `  ${response.model} · block ${thresholds.block} / review ${thresholds.review} · ${formatUsd(runner.cost.usd)}`,
          ),
        );
      }
    }

    const failOn = str(flags, "fail-on");
    if (failOn === "block" && action === "block") {
      throw gateError(`Screening blocked this content: ${reason}`, { action, triggered });
    }
    if (failOn === "review" && action !== "pass") {
      throw gateError(`Screening resolved to ${action}: ${reason}`, { action, triggered });
    }
  },
};
