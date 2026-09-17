import { pool } from "../../core/client.ts";
import { formatUsd } from "../../core/cost.ts";
import { usageError } from "../../core/exit.ts";
import { parseCandidates, type Candidate } from "../../core/input.ts";
import { Painter, bar, printField, printJson, writeLine } from "../../render/output.ts";
import type { CommandSpec } from "../../router.ts";
import { clip, makeRunner, num, outputFrom, probability, required, str, stdinText } from "../common.ts";
import { readFileSync, existsSync, statSync } from "node:fs";

/**
 * Re-rank candidates by relevance to a task.
 *
 * Each candidate is a different state, so this is one request per candidate rather
 * than one request overall. That is the expensive shape, which is why --max-chars
 * truncates by default and why results are cached: re-running the same ranking after
 * an interrupted session costs nothing.
 */
export const rank: CommandSpec = {
  name: "rank",
  group: "Recipes",
  summary: "Re-rank files or lines by how well they serve a task",
  args: "[file...]",
  description: `
Reads candidates from arguments or stdin and sorts them by the probability that each
one helps with --task. Candidates may be file paths, ripgrep hits in path:line:text
form, JSON Lines objects with "text" or "path", or a JSON array.

The original input order is kept alongside the new rank, so a move up or down is
visible at a glance. Use --top to keep only the head of the list, and --min to drop
everything the model is not reasonably sure about.
`,
  flags: {
    task: { type: "string", short: "t", value: "<text>", description: "What the candidate has to be useful for" },
    top: { type: "number", value: "<n>", description: "Keep only the highest n candidates" },
    min: { type: "number", value: "<0-1>", description: "Drop candidates below this probability", default: "0" },
    "max-chars": {
      type: "number",
      value: "<n>",
      description: "Truncate each candidate to this many characters",
      default: "4000",
    },
    true: { type: "string", value: "<text>", description: "What a relevant candidate looks like" },
    false: { type: "string", value: "<text>", description: "What an irrelevant candidate looks like" },
  },
  examples: [
    `fd -e ts src | tsai rank -t "handles websocket reconnection" --top 5`,
    `rg -n "TODO" --no-heading | tsai rank -t "blocks the next release" --min 0.6`,
    `tsai rank -t "explains how to configure auth" docs/*.md --json | jq -r '.results[0].id'`,
  ],
  async run({ flags, positionals }) {
    const task = required(flags, "task", 'Example: -t "implements the retry policy"');
    const mode = outputFrom(flags);
    const runner = makeRunner(flags);
    const minimum = probability(flags, "min", 0);
    const maxChars = num(flags, "max-chars") ?? 4000;

    let candidates: Candidate[];
    if (positionals.length > 0) {
      candidates = positionals.map((path) => {
        if (!existsSync(path) || !statSync(path).isFile()) {
          throw usageError(`Not a readable file: ${path}`);
        }
        return { id: path, text: readFileSync(path, "utf8"), path };
      });
    } else {
      candidates = parseCandidates(await stdinText());
    }

    if (candidates.length === 0) {
      throw usageError(
        "No candidates to rank.",
        "Pipe paths or ripgrep hits on stdin, or pass file paths as arguments.",
      );
    }

    const yes = str(flags, "true") ?? "The candidate contains information or code that directly serves the task.";
    const no = str(flags, "false") ?? "The candidate is unrelated, or only touches the task incidentally.";

    const payloads = candidates.map((candidate) =>
      runner.buildPayload(
        {
          task,
          candidate: {
            ...(candidate.path ? { path: candidate.path } : {}),
            ...(candidate.line !== undefined ? { line: candidate.line } : {}),
            content: clip(candidate.text, maxChars),
          },
        },
        {
          relevant: {
            type: "noul",
            instructions:
              "Does the content in `candidate` help accomplish the work described in `task`? Judge the content itself, not whether its filename sounds related.",
            criteria: { true: yes, false: no },
          },
        },
        str(flags, "model"),
      ),
    );

    if (flags["dry-run"] === true) {
      printJson({ dry_run: true, requests: payloads.length, body: payloads[0] }, mode);
      return;
    }

    const scored = await pool(payloads, runner.config.settings.concurrency, async (payload, index) => {
      const response = await runner.systemOne(payload);
      const answer = response.answers.relevant;
      const value = answer && answer.type === "noul" ? answer.noul : 0;
      return { candidate: candidates[index] as Candidate, noul: value, original: index + 1 };
    });

    const ordered = [...scored]
      .sort((a, b) => b.noul - a.noul)
      .filter((entry) => entry.noul >= minimum);
    const limit = num(flags, "top");
    const kept = limit !== undefined ? ordered.slice(0, Math.max(0, limit)) : ordered;

    const document = {
      task,
      model: runner.config.settings.model,
      thresholds: { min: minimum, ...(limit !== undefined ? { top: limit } : {}) },
      considered: candidates.length,
      results: kept.map((entry, index) => ({
        rank: index + 1,
        previous_rank: entry.original,
        id: entry.candidate.id,
        ...(entry.candidate.path ? { path: entry.candidate.path } : {}),
        ...(entry.candidate.line !== undefined ? { line: entry.candidate.line } : {}),
        noul: entry.noul,
      })),
      usage: { ...runner.cost, cache_hits: runner.cacheHits },
    };

    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) return printJson(document, mode);

    const paint = new Painter(mode.color);
    writeLine("");
    if (kept.length === 0) {
      writeLine(paint.dim(`  No candidate reached ${minimum}. ${candidates.length} considered.`));
    }
    for (const [index, entry] of kept.entries()) {
      const moved = entry.original - (index + 1);
      const arrow = moved > 0 ? paint.green(`+${moved}`) : moved < 0 ? paint.red(String(moved)) : paint.dim("  0");
      writeLine(
        `  ${paint.dim(String(index + 1).padStart(3))} ${paint.byStrength(entry.noul, entry.noul.toFixed(2))} ${paint.dim(
          bar(entry.noul, 8),
        )} ${arrow}  ${entry.candidate.id}`,
      );
    }
    writeLine("");
    if (!mode.quiet) {
      writeLine(
        paint.dim(
          `  ${candidates.length} candidates · ${runner.cost.requests} requests · ${runner.cacheHits} cached · ${formatUsd(runner.cost.usd)} · min ${minimum}`,
        ),
      );
    }
  },
};
