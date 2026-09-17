import type { ChoiceCriteria } from "@typesafe-ai/sdk";
import type { Answer } from "../../core/client.ts";
import { formatUsd } from "../../core/cost.ts";
import { gateError, usageError } from "../../core/exit.ts";
import {
  lineCriteria,
  renderTagged,
  tagLines,
  windowDescription,
  windowLines,
  type TaggedLine,
} from "../../core/lines.ts";
import { LIMITS } from "../../core/validate.ts";
import { Painter, bar, printField, printJson, writeLine } from "../../render/output.ts";
import type { CommandSpec } from "../../router.ts";
import { makeRunner, num, outputFrom, probability, required, str, stdinText } from "../common.ts";
import { readFileSync } from "node:fs";

interface Hit {
  line: number;
  text: string;
  probability: number;
}

const asChoice = (answer: Answer | undefined): Record<string, number> =>
  answer && answer.type === "choice" ? answer.probabilities : {};

/**
 * Semantic line search.
 *
 * Lines are tagged `L000|` and sent once as state, then a single Choice over the tags
 * names the line. The tags mean the model identifies a line without reproducing its
 * text, and a companion Noul asks whether any line answers at all, so an absent match
 * is reported as absent rather than as the least-bad line.
 */
export const find: CommandSpec = {
  name: "find",
  group: "Recipes",
  summary: "Find the line in a file that answers a question",
  args: "<file>",
  description: `
Returns file:line references, so the output drops straight into an editor or a
follow-up command.

Files longer than ${LIMITS.MAX_CHOICE_OPTIONS} lines exceed what one Choice can cover,
so they are searched in two passes: one Choice picks a window of lines, a second picks
the line inside it. That costs two requests instead of one and re-sends only the
chosen window.

The reported "present" probability is a separate judgment about whether the file
contains an answer at all. A high line probability with a low present probability
means the model picked the closest line in a file that does not actually answer.
`,
  flags: {
    query: { type: "string", short: "t", value: "<text>", description: "What to look for" },
    top: { type: "number", value: "<n>", description: "Return this many lines", default: "1" },
    window: {
      type: "number",
      value: "<n>",
      description: "Lines per window for large files",
      default: String(LIMITS.MAX_CHOICE_OPTIONS),
    },
    "min-present": {
      type: "number",
      value: "<0-1>",
      description: "Exit 6 when the file is less likely than this to contain an answer",
    },
  },
  examples: [
    `tsai find -t "where the retry backoff is computed" src/core/client.ts`,
    `tsai find -t "the line that sets the timeout" src/config.ts --field results.0.line`,
    `git show HEAD:src/app.ts | tsai find -t "where routing is registered" --top 3`,
  ],
  async run({ flags, positionals }) {
    const query = required(flags, "query", 'Example: -t "where the session cookie is set"');
    const mode = outputFrom(flags);
    const runner = makeRunner(flags);
    const path = positionals[0];
    const top = Math.max(1, num(flags, "top") ?? 1);

    const text = path ? readFileSync(path, "utf8") : await stdinText();
    if (text.trim() === "") {
      throw usageError("Nothing to search.", "Pass a file path, or pipe the file contents on stdin.");
    }

    const all = tagLines(text);
    const label = path ?? "(stdin)";
    const windowSize = num(flags, "window") ?? LIMITS.MAX_CHOICE_OPTIONS;

    const presentQuestion = {
      type: "noul" as const,
      instructions:
        "Does any line in `document` answer the question in `query`? Answer about the document as a whole, not about any single line.",
      criteria: {
        true: "At least one line directly answers the question.",
        false: "No line answers it. The document is about something else, or only touches it in passing.",
      },
    };

    let searchIn: TaggedLine[] = all;
    let present = 0;

    if (all.length > LIMITS.MAX_CHOICE_OPTIONS) {
      // Pass one: narrow to a window. Each window is described by its range and the
      // first few non-blank lines it contains.
      const windows = windowLines(all, windowSize);
      const criteria: ChoiceCriteria = {};
      for (const window of windows) criteria[window.id] = windowDescription(window);

      const first = await runner.systemOne(
        runner.buildPayload(
          // Only the query goes in the state: each window's preview already lives in the
          // criteria, and sending it twice would double the bill for the first pass.
          { query, file: label },
          {
            section: {
              type: "choice",
              instructions:
                "Which section of the file is most likely to contain the line that answers `query`?",
              criteria,
            },
            present: presentQuestion,
          },
          str(flags, "model"),
        ),
      );

      const sectionAnswer = first.answers.section;
      const presentAnswer = first.answers.present;
      present = presentAnswer && presentAnswer.type === "noul" ? presentAnswer.noul : 0;
      const chosen = sectionAnswer && sectionAnswer.type === "choice" ? sectionAnswer.choice : windows[0]?.id;
      searchIn = windows.find((window) => window.id === chosen)?.lines ?? (windows[0]?.lines ?? []);
    }

    const criteria = lineCriteria(searchIn);
    const payload = runner.buildPayload(
      { query, document: renderTagged(searchIn) },
      {
        line: {
          type: "choice",
          instructions:
            "Which tagged line in `document` best answers `query`? Each line is prefixed with its tag followed by a pipe; answer with the tag.",
          criteria,
        },
        ...(all.length > LIMITS.MAX_CHOICE_OPTIONS ? {} : { present: presentQuestion }),
      },
      str(flags, "model"),
    );

    if (flags["dry-run"] === true) {
      printJson({ dry_run: true, body: payload }, mode);
      return;
    }

    const response = await runner.systemOne(payload);
    const presentAnswer = response.answers.present;
    if (presentAnswer && presentAnswer.type === "noul") present = presentAnswer.noul;

    const probabilities = asChoice(response.answers.line);
    const byId = new Map(searchIn.map((line) => [line.id, line]));
    const hits: Hit[] = Object.entries(probabilities)
      .sort(([, a], [, b]) => b - a)
      .slice(0, top)
      .flatMap(([id, value]) => {
        const line = byId.get(id);
        return line ? [{ line: line.number, text: line.text, probability: value }] : [];
      });

    const document = {
      query,
      file: label,
      lines_searched: searchIn.length,
      lines_total: all.length,
      present,
      results: hits.map((hit) => ({
        ref: `${label}:${hit.line}`,
        line: hit.line,
        text: hit.text,
        probability: hit.probability,
      })),
      usage: { ...runner.cost, cache_hits: runner.cacheHits },
    };

    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) printJson(document, mode);
    else {
      const paint = new Painter(mode.color);
      writeLine("");
      for (const hit of hits) {
        writeLine(
          `  ${paint.cyan(`${label}:${hit.line}`)}  ${paint.byStrength(
            hit.probability,
            hit.probability.toFixed(2),
          )} ${paint.dim(bar(hit.probability, 8))}`,
        );
        writeLine(`    ${hit.text.trim().slice(0, 100)}`);
      }
      writeLine("");
      if (!mode.quiet) {
        writeLine(
          paint.dim(
            `  present ${present.toFixed(2)} · ${searchIn.length}/${all.length} lines · ${runner.cost.requests} requests · ${formatUsd(runner.cost.usd)}`,
          ),
        );
      }
    }

    const minPresent = num(flags, "min-present");
    if (minPresent !== undefined) {
      probability(flags, "min-present", 0);
      if (present < minPresent) {
        throw gateError(`No answer found: present ${present.toFixed(2)} is below ${minPresent}.`, {
          present,
          required: minPresent,
        });
      }
    }
  },
};
