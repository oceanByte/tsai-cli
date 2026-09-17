import { readFileSync } from "node:fs";
import type { ChoiceCriteria, EntryType } from "@typesafe-ai/sdk";
import { pool } from "../../core/client.ts";
import { formatUsd } from "../../core/cost.ts";
import { usageError } from "../../core/exit.ts";
import { parseJson } from "../../core/input.ts";
import { LIMITS } from "../../core/validate.ts";
import { Painter, bar, printField, printJson, writeLine } from "../../render/output.ts";
import type { CommandSpec } from "../../router.ts";
import { STATE_FLAGS, bool, list, loadState, makeRunner, num, outputFrom, str } from "../common.ts";
import { parseLabelPairs } from "../primitives.ts";

/**
 * A taxonomy node. A string value is shorthand for a described leaf.
 *
 *   { "billing": { "description": "...", "children": { "refund": "asks for money back" } } }
 */
export interface TaxonomyNode {
  description?: string;
  children?: Record<string, TaxonomyNode | string>;
}

export type Taxonomy = Record<string, TaxonomyNode | string>;

const asNode = (value: TaxonomyNode | string): TaxonomyNode =>
  typeof value === "string" ? { description: value } : value;

interface Beam {
  path: string[];
  node: TaxonomyNode;
  /** Sum of log probabilities along the path, for length-normalized scoring. */
  logSum: number;
  depth: number;
}

/**
 * Length-normalized path score, exp(mean(log p)).
 *
 * A plain product punishes depth, so a shallow confident path would always beat a
 * deep one. The geometric mean makes paths of different lengths comparable.
 */
export const pathScore = (logSum: number, depth: number): number =>
  depth === 0 ? 0 : Math.exp(logSum / depth);

export const classify: CommandSpec = {
  name: "classify",
  group: "Recipes",
  summary: "Route text into a flat set of labels or a taxonomy",
  args: "[file...]",
  description: `
With -c options it is one Choice over a flat label set. With --tree it walks a
taxonomy one level at a time, keeping the --beam best paths at each level.

Beam search matters because a greedy walk commits to the wrong branch at the top and
can never recover: the correct leaf is unreachable once its parent is discarded.
Keeping several branches alive costs one request per surviving branch per level.

A taxonomy file maps labels to nodes. A string value is shorthand for a leaf with
that description:

  { "billing": { "description": "money", "children": { "refund": "wants money back" } } }
`,
  flags: {
    ...STATE_FLAGS,
    instructions: { type: "string", short: "i", value: "<text>", description: "What the classification is for" },
    criterion: {
      type: "string",
      short: "c",
      multiple: true,
      value: "<label=description>",
      description: "A flat label, repeatable",
    },
    tree: { type: "string", value: "<path>", description: "A taxonomy JSON file to walk" },
    beam: { type: "number", value: "<n>", description: "Branches kept alive per level", default: "3" },
    top: { type: "number", value: "<n>", description: "Paths to report", default: "1" },
    none: { type: "boolean", description: "Offer a 'none' label at every level" },
  },
  examples: [
    `tsai classify -i "Which team owns this?" -c backend -c frontend -c infra ticket.txt`,
    `tsai classify --tree taxonomy.json --beam 3 --top 3 --state "my card was charged twice"`,
    `tsai classify --tree areas.json ticket.txt --field paths.0.path`,
  ],
  async run({ flags, positionals }) {
    const mode = outputFrom(flags);
    const runner = makeRunner(flags);
    const state: EntryType = await loadState(flags, positionals);
    const treePath = str(flags, "tree");
    const instructions =
      str(flags, "instructions") ?? "Which of these best describes the content of `state`?";
    const top = Math.max(1, num(flags, "top") ?? 1);

    if (!treePath) {
      const criteria = parseLabelPairs(list(flags, "criterion"));
      if (bool(flags, "none")) criteria.none = "No other label applies.";
      if (Object.keys(criteria).length < 2) {
        throw usageError(
          "A flat classification needs at least two labels.",
          "Repeat -c label=description, or pass --tree <taxonomy.json>.",
        );
      }
      const payload = runner.buildPayload(state, { label: { type: "choice", instructions, criteria } }, str(flags, "model"));
      if (bool(flags, "dry-run")) return printJson({ dry_run: true, body: payload }, mode);

      const response = await runner.systemOne(payload);
      const answer = response.answers.label;
      const probabilities = answer && answer.type === "choice" ? answer.probabilities : {};
      const ranked = Object.entries(probabilities)
        .sort(([, a], [, b]) => b - a)
        .slice(0, top)
        .map(([label, probability]) => ({ path: [label], label, score: probability }));

      const document = {
        paths: ranked,
        confidence: answer && answer.type === "choice" ? answer.confidence : 0,
        model: response.model,
        usage: response.usage,
        cached: response.cached,
      };
      if (mode.field) return printField(document, mode.field);
      if (!mode.pretty) return printJson(document, mode);
      return renderPaths(ranked, mode.color, runner, document.confidence, 1);
    }

    const taxonomy = parseJson(readFileSync(treePath, "utf8"), treePath) as Taxonomy;
    if (!taxonomy || typeof taxonomy !== "object" || Array.isArray(taxonomy)) {
      throw usageError(`${treePath} must be a JSON object mapping labels to nodes.`);
    }
    const width = Math.max(1, num(flags, "beam") ?? 3);

    let live: Beam[] = [{ path: [], node: { children: taxonomy }, logSum: 0, depth: 0 }];
    const finished: Beam[] = [];
    let level = 0;

    while (live.length > 0) {
      level += 1;
      if (level > 16) throw usageError("Taxonomy is deeper than 16 levels.", "Flatten it, or split the walk.");

      const hasChildren = (beam: Beam): boolean => {
        const children = beam.node.children;
        return children !== undefined && Object.keys(children).length > 0;
      };
      const expandable = live.filter(hasChildren);
      // A beam with no children has reached a leaf. Retire it here, and only here, so
      // it cannot also be counted as still live when the walk ends.
      finished.push(...live.filter((beam) => !hasChildren(beam)));
      live = expandable;
      if (expandable.length === 0) break;

      const responses = await pool(expandable, runner.config.settings.concurrency, async (beam) => {
        const children = beam.node.children as Record<string, TaxonomyNode | string>;
        const criteria: ChoiceCriteria = {};
        for (const [label, child] of Object.entries(children)) {
          criteria[label] = asNode(child).description ?? null;
        }
        if (bool(flags, "none")) criteria.none = "No label at this level applies.";
        if (Object.keys(criteria).length > LIMITS.MAX_CHOICE_OPTIONS) {
          throw usageError(
            `Taxonomy node "${beam.path.join("/") || "(root)"}" has ${Object.keys(criteria).length} children; at most ${LIMITS.MAX_CHOICE_OPTIONS} are allowed.`,
          );
        }
        if (Object.keys(criteria).length < 2) {
          // A single child is not a decision; take it without spending a request.
          return { beam, criteria, probabilities: { [Object.keys(criteria)[0] as string]: 1 } };
        }
        const response = await runner.systemOne(
          runner.buildPayload(
            {
              state,
              ...(beam.path.length > 0 ? { already_classified_as: beam.path } : {}),
            },
            {
              label: {
                type: "choice",
                instructions:
                  beam.path.length > 0
                    ? `${instructions} The content is already classified as ${beam.path.join(" > ")}; choose within that.`
                    : instructions,
                criteria,
              },
            },
            str(flags, "model"),
          ),
        );
        const answer = response.answers.label;
        return {
          beam,
          criteria,
          probabilities: answer && answer.type === "choice" ? answer.probabilities : {},
        };
      });

      const next: Beam[] = [];
      for (const { beam, probabilities } of responses) {
        const children = beam.node.children as Record<string, TaxonomyNode | string>;
        for (const [label, probability] of Object.entries(probabilities)) {
          if (probability <= 0) continue;
          const child = children[label];
          if (child === undefined) {
            // The escape option: stop here rather than descending into nothing.
            finished.push({
              path: [...beam.path, label],
              node: {},
              logSum: beam.logSum + Math.log(probability),
              depth: beam.depth + 1,
            });
            continue;
          }
          next.push({
            path: [...beam.path, label],
            node: asNode(child),
            logSum: beam.logSum + Math.log(probability),
            depth: beam.depth + 1,
          });
        }
      }

      next.sort((a, b) => pathScore(b.logSum, b.depth) - pathScore(a.logSum, a.depth));
      live = next.slice(0, width);
    }

    const ranked = finished
      .map((beam) => ({ path: beam.path, label: beam.path.join(" > "), score: pathScore(beam.logSum, beam.depth) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, top);

    const document = {
      paths: ranked,
      beam: width,
      depth: Math.max(0, ...finished.map((beam) => beam.depth)),
      model: runner.config.settings.model,
      usage: { ...runner.cost, cache_hits: runner.cacheHits },
    };
    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) return printJson(document, mode);
    renderPaths(ranked, mode.color, runner, undefined, width);
  },
};

function renderPaths(
  ranked: Array<{ path: string[]; label: string; score: number }>,
  color: boolean,
  runner: { cost: { usd: number; requests: number } },
  confidence: number | undefined,
  width: number,
): void {
  const paint = new Painter(color);
  writeLine("");
  for (const entry of ranked) {
    writeLine(
      `  ${paint.byStrength(entry.score, entry.score.toFixed(2))} ${paint.dim(bar(entry.score, 8))}  ${paint.cyan(entry.label)}`,
    );
  }
  writeLine("");
  const parts = [`${runner.cost.requests} requests`, `beam ${width}`, formatUsd(runner.cost.usd)];
  if (confidence !== undefined) parts.unshift(`conf ${confidence.toFixed(2)}`);
  writeLine(paint.dim(`  ${parts.join(" · ")}`));
}
