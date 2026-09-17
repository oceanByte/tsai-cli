import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Questions } from "@typesafe-ai/sdk";
import type { Answer } from "../../core/client.ts";
import { settledPool } from "../../core/client.ts";
import { formatUsd } from "../../core/cost.ts";
import { normalizeError } from "../../core/errors.ts";
import { CliError, EXIT, gateError, usageError } from "../../core/exit.ts";
import { parseJson } from "../../core/input.ts";
import { Painter, bar, printField, printJson, writeLine } from "../../render/output.ts";
import type { CommandSpec } from "../../router.ts";
import { bool, clip, makeRunner, num, outputFrom, probability, str, stdinText } from "../common.ts";
import builtinChecklist from "../../../presets/review.json" with { type: "json" };

export interface DiffPart {
  /** Path the hunk or file belongs to. */
  path: string;
  /** Unified diff text for this part. */
  diff: string;
  /** Hunk header when splitting by hunk. */
  hunk?: string;
}

/** Split a unified diff into per-file parts on `diff --git` boundaries. */
export function splitByFile(diff: string): DiffPart[] {
  const parts: DiffPart[] = [];
  const chunks = diff.split(/^diff --git /m).filter((chunk) => chunk.trim() !== "");
  for (const chunk of chunks) {
    const header = chunk.split("\n", 1)[0] ?? "";
    // `a/path b/path`, where a path may contain spaces; take the b-side.
    const match = /\sb\/(.+)$/.exec(header) ?? /^a\/(.+?)\s/.exec(header);
    const path = match?.[1]?.trim() ?? header.trim();
    parts.push({ path, diff: `diff --git ${chunk}`.trimEnd() });
  }
  return parts;
}

/** Split further, one part per @@ hunk, keeping the file header with each. */
export function splitByHunk(parts: readonly DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const part of parts) {
    const lines = part.diff.split("\n");
    const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
    if (firstHunk === -1) {
      out.push(part);
      continue;
    }
    const header = lines.slice(0, firstHunk).join("\n");
    let current: string[] = [];
    let hunkHeader = "";
    const flush = () => {
      if (current.length === 0) return;
      out.push({ path: part.path, hunk: hunkHeader, diff: `${header}\n${current.join("\n")}` });
      current = [];
    };
    for (const line of lines.slice(firstHunk)) {
      if (line.startsWith("@@")) {
        flush();
        hunkHeader = line;
      }
      current.push(line);
    }
    flush();
  }
  return out;
}

function gitDiff(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(EXIT.USAGE, `git ${args.join(" ")} failed: ${message.split("\n")[0]}`, {
      hint: "Run this inside a git repository, or pipe a unified diff on stdin.",
    });
  }
}

interface FileReview {
  path: string;
  hunk?: string;
  findings: Array<{ check: string; noul: number }>;
  severity?: number;
  error?: unknown;
}

export const review: CommandSpec = {
  name: "review",
  group: "Recipes",
  summary: "Review a git diff against a checklist",
  description: `
Runs a checklist of convention questions over each changed file in one request per
file. Every question in the checklist sees the same diff, so a checklist of ten
questions costs barely more than a checklist of one.

By default it reviews the working tree against HEAD. Use --staged for what is about
to be committed, --diff <ref> for an arbitrary range, or pipe a unified diff on stdin.

The shipped checklist looks for committed secrets, unhandled failures, debugging
leftovers, breaking changes, missing tests, and unclear names, plus a severity score.
Replace it with --checklist to enforce your own conventions.

This reads a diff, so it judges the change rather than the file. A finding about code
the diff only touches in passing is expected; --min raises the bar for reporting one.
`,
  flags: {
    diff: { type: "string", value: "<ref>", description: "Diff against this ref or range instead of HEAD" },
    staged: { type: "boolean", description: "Review the staged changes" },
    checklist: { type: "string", value: "<path>", description: "A custom checklist question set" },
    per: {
      type: "string",
      value: "<unit>",
      choices: ["file", "hunk"],
      description: "Review each file as one state, or each hunk separately",
      default: "file",
    },
    min: { type: "number", value: "<0-1>", description: "Report findings at or above this", default: "0.6" },
    "fail-on": { type: "number", value: "<0-1>", description: "Exit 6 when any finding reaches this" },
    "max-chars": { type: "number", value: "<n>", description: "Truncate each diff part", default: "12000" },
  },
  examples: [
    `tsai review --staged --fail-on 0.8      # a pre-commit hook`,
    `tsai review --diff main...HEAD --json | jq '.findings[]'`,
    `git diff HEAD~3 | tsai review --per hunk --min 0.7`,
  ],
  async run({ flags }) {
    const mode = outputFrom(flags);
    const runner = makeRunner(flags);
    const minimum = probability(flags, "min", 0.6);
    const maxChars = num(flags, "max-chars") ?? 12000;

    // An explicit source means stdin is never read, so an idle pipe cannot hang this.
    let diff: string;
    if (bool(flags, "staged")) diff = gitDiff(["diff", "--cached"]);
    else if (str(flags, "diff") !== undefined && str(flags, "diff") !== "-") {
      diff = gitDiff(["diff", str(flags, "diff") as string]);
    } else if (str(flags, "diff") === "-") diff = await stdinText();
    else {
      const piped = await stdinText();
      diff = piped.trim() !== "" ? piped : gitDiff(["diff", "HEAD"]);
    }

    if (diff.trim() === "") {
      throw usageError(
        "The diff is empty, so there is nothing to review.",
        "Use --staged, --diff <ref>, or pipe a unified diff on stdin.",
      );
    }

    const checklistPath = str(flags, "checklist");
    const questions = (
      checklistPath ? parseJson(readFileSync(checklistPath, "utf8"), checklistPath) : builtinChecklist
    ) as Questions;

    const byFile = splitByFile(diff);
    const parts = str(flags, "per") === "hunk" ? splitByHunk(byFile) : byFile;
    if (parts.length === 0) throw usageError("No file changes found in the diff.");

    const payloads = parts.map((part) =>
      runner.buildPayload(
        {
          file: part.path,
          ...(part.hunk ? { hunk: part.hunk } : {}),
          change: clip(part.diff, maxChars),
        },
        questions,
        str(flags, "model"),
      ),
    );

    if (bool(flags, "dry-run")) {
      printJson({ dry_run: true, parts: parts.length, body: payloads[0] }, mode);
      return;
    }

    const settled = await settledPool(payloads, runner.config.settings.concurrency, (payload) =>
      runner.systemOne(payload),
    );

    const reviews: FileReview[] = settled.map((result, index) => {
      const part = parts[index] as DiffPart;
      if (!result.ok) {
        return { path: part.path, ...(part.hunk ? { hunk: part.hunk } : {}), findings: [], error: result.error };
      }
      const findings: Array<{ check: string; noul: number }> = [];
      let severity: number | undefined;
      for (const [id, answer] of Object.entries(result.value.answers as Record<string, Answer>)) {
        if (answer.type === "noul") findings.push({ check: id, noul: answer.noul });
        else if (answer.type === "score" && id === "severity") severity = answer.score;
      }
      findings.sort((a, b) => b.noul - a.noul);
      return {
        path: part.path,
        ...(part.hunk ? { hunk: part.hunk } : {}),
        findings: findings.filter((finding) => finding.noul >= minimum),
        ...(severity !== undefined ? { severity } : {}),
      };
    });

    const flat = reviews.flatMap((entry) =>
      entry.findings.map((finding) => ({
        path: entry.path,
        ...(entry.hunk ? { hunk: entry.hunk } : {}),
        check: finding.check,
        noul: finding.noul,
      })),
    );
    flat.sort((a, b) => b.noul - a.noul);

    const errors = reviews.filter((entry) => entry.error !== undefined);
    const document = {
      unit: str(flags, "per") ?? "file",
      thresholds: { min: minimum },
      reviewed: parts.length,
      findings: flat,
      files: reviews.map((entry) => ({
        path: entry.path,
        ...(entry.hunk ? { hunk: entry.hunk } : {}),
        ...(entry.severity !== undefined ? { severity: entry.severity } : {}),
        findings: entry.findings,
        ...(entry.error ? { error: normalizeError(entry.error).normalized } : {}),
      })),
      model: runner.config.settings.model,
      usage: { ...runner.cost, cache_hits: runner.cacheHits },
    };

    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) printJson(document, mode);
    else {
      const paint = new Painter(mode.color);
      writeLine("");
      if (flat.length === 0) writeLine(paint.green(`  Nothing at or above ${minimum} across ${parts.length} parts.`));
      let lastPath = "";
      for (const finding of flat) {
        if (finding.path !== lastPath) {
          writeLine(`  ${paint.bold(finding.path)}`);
          lastPath = finding.path;
        }
        writeLine(
          `    ${paint.byStrength(finding.noul, finding.noul.toFixed(2))} ${paint.dim(bar(finding.noul, 8))}  ${finding.check}${finding.hunk ? paint.dim(`  ${finding.hunk}`) : ""}`,
        );
      }
      writeLine("");
      if (!mode.quiet) {
        writeLine(
          paint.dim(
            `  ${parts.length} parts · ${flat.length} findings · ${runner.cost.requests} requests · ${formatUsd(runner.cost.usd)} · min ${minimum}`,
          ),
        );
      }
    }

    if (errors.length > 0) {
      throw new CliError(EXIT.SERVER, `${errors.length} of ${parts.length} parts could not be reviewed.`, {
        hint: "Each failed part carries its error in the files array.",
      });
    }

    const failOn = num(flags, "fail-on");
    if (failOn !== undefined) {
      probability(flags, "fail-on", 0);
      const breaching = flat.filter((finding) => finding.noul >= failOn);
      if (breaching.length > 0) {
        throw gateError(`${breaching.length} finding(s) at or above ${failOn}.`, { findings: breaching });
      }
    }
  },
};
