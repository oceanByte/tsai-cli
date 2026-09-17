import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { EntryType, Question, Questions } from "@typesafe-ai/sdk";
import { usageError } from "./exit.ts";

/**
 * How long to wait for the first byte on stdin before concluding nothing is coming.
 * Override with TYPESAFE_STDIN_TIMEOUT, or set it to 0 to wait indefinitely.
 */
export const STDIN_GRACE_MS = (() => {
  const raw = Number(process.env.TYPESAFE_STDIN_TIMEOUT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
})();

/**
 * Read all of stdin, with a deadline on the first byte only.
 *
 * An agent harness routinely leaves an idle pipe attached to stdin, so a plain read
 * to EOF can hang a command that had everything it needed on the command line.
 * Waiting only for the first byte keeps that safe without truncating a slow producer:
 * once any data arrives the stream is real and the rest is read with no limit.
 * A timeout yields an empty string, which callers already treat as "no stdin".
 */
export function readStdin(graceMs: number = STDIN_GRACE_MS): Promise<string> {
  const input = process.stdin;
  if (input.isTTY) return Promise.resolve("");

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (settle: () => void) => {
      if (timer) clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      // The producer is alive, so stop policing the clock.
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    const onError = (error: Error) => finish(() => reject(error));

    if (graceMs > 0) {
      timer = setTimeout(() => finish(() => resolve("")), graceMs);
      timer.unref?.();
    }
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

export const hasStdin = (): boolean => !process.stdin.isTTY;

function readTextFile(path: string): string {
  if (!existsSync(path)) throw usageError(`File not found: ${path}`);
  try {
    if (statSync(path).isDirectory()) throw usageError(`Expected a file but got a directory: ${path}`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && error.name === "CliError") throw error;
    throw usageError(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw usageError(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface StateOptions {
  /** Positional file paths. */
  files: string[];
  /** Inline literal text from --state. */
  text?: string;
  /** Path from --state-file. */
  file?: string;
  /** Raw JSON from --state-json, used verbatim as structured state. */
  json?: string;
  /** Text already read from stdin, if the caller consumed it. */
  stdin?: string;
}

/**
 * Resolve the state to evaluate.
 *
 * Several files become a JSON object keyed by filename rather than a concatenated
 * blob, because the docs are explicit that named fields keep the relationships
 * between parts of the state legible to the model.
 */
export function resolveState(options: StateOptions): EntryType {
  const sources = [
    options.json !== undefined,
    options.text !== undefined,
    options.file !== undefined,
    options.files.length > 0,
  ].filter(Boolean).length;
  if (sources > 1) {
    throw usageError(
      "State was supplied more than once.",
      "Use exactly one of: file arguments, --state, --state-file, or --state-json.",
    );
  }

  if (options.json !== undefined) return parseJson(options.json, "--state-json") as EntryType;
  if (options.text !== undefined) return options.text;
  if (options.file !== undefined) return readTextFile(options.file);

  if (options.files.length === 1) return readTextFile(options.files[0] as string);

  if (options.files.length > 1) {
    const state: Record<string, string> = {};
    for (const path of options.files) {
      // Key on the full path so two files with the same basename stay distinct.
      const key = state[basename(path)] === undefined && !options.files.some(
        (other) => other !== path && basename(other) === basename(path),
      )
        ? basename(path)
        : path;
      state[key] = readTextFile(path);
    }
    return state;
  }

  if (options.stdin !== undefined && options.stdin !== "") return options.stdin;
  throw usageError(
    "No state supplied.",
    "Pass a file path, use --state <text>, or pipe text on stdin.",
  );
}

/** Coerce a parsed value into a questions map, rejecting anything else clearly. */
function asQuestions(value: unknown, origin: string): Questions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError(`${origin} must be a JSON object mapping question ids to questions.`);
  }
  const record = value as Record<string, unknown>;
  // Tolerate a full request body where only the questions were wanted.
  if ("questions" in record && record.questions && typeof record.questions === "object") {
    return record.questions as Questions;
  }
  return record as Questions;
}

export interface QuestionOptions {
  /** Path from --questions, or "-" for stdin. */
  file?: string;
  /** Repeatable inline JSON from -q/--question. */
  inline: string[];
  /** Text already read from stdin, if the caller consumed it. */
  stdin?: string;
}

/**
 * Resolve the question set.
 *
 * Inline questions may be either a full map (`{"id": {...}}`) or a single bare
 * question object, which is then given a generated id. Both forms show up in agent
 * usage and the difference is unambiguous, so accept both.
 */
export function resolveQuestions(options: QuestionOptions): Questions {
  const collected: Questions = {};

  if (options.file !== undefined) {
    const text =
      options.file === "-"
        ? (options.stdin ?? "")
        : readTextFile(options.file);
    if (text.trim() === "") throw usageError(`Question source ${options.file} is empty.`);
    Object.assign(collected, asQuestions(parseJson(text, `--questions ${options.file}`), "--questions"));
  }

  options.inline.forEach((raw, index) => {
    const parsed = parseJson(raw, "--question") as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw usageError("--question must be a JSON object.");
    }
    if (typeof parsed.type === "string") {
      // A bare question object; synthesize an id.
      collected[`q${index + 1}`] = parsed as unknown as Question;
    } else {
      Object.assign(collected, asQuestions(parsed, "--question"));
    }
  });

  return collected;
}

/**
 * Read candidate items for the fan-out recipes.
 *
 * Accepts three shapes on the same stream so it composes with common tools:
 * JSON Lines objects (`{"id":..,"text":..}`), a JSON array, or one plain line per
 * item as produced by `fd`, `rg -l`, or `git diff --name-only`.
 */
export interface Candidate {
  id: string;
  text: string;
  /** Source path when the candidate came from a file listing. */
  path?: string;
  /** 1-based line number when the candidate came from a grep hit. */
  line?: number;
}

export function parseCandidates(input: string, opts: { readFiles?: boolean } = {}): Candidate[] {
  const trimmed = input.trim();
  if (trimmed === "") return [];

  // A whole-input JSON array.
  if (trimmed.startsWith("[")) {
    const parsed = parseJson(trimmed, "candidate input") as unknown[];
    return parsed.map((entry, i) => normalizeCandidate(entry, i, opts));
  }

  const lines = trimmed.split("\n").filter((l) => l.trim() !== "");
  return lines.map((line, i) => {
    const t = line.trim();
    if (t.startsWith("{")) return normalizeCandidate(parseJson(t, "candidate line"), i, opts);
    return normalizeCandidate(t, i, opts);
  });
}

function normalizeCandidate(entry: unknown, index: number, opts: { readFiles?: boolean }): Candidate {
  if (typeof entry === "string") {
    // A `path:line:text` grep hit, a bare path, or free text.
    const grep = /^([^:]+):(\d+):(.*)$/.exec(entry);
    if (grep && existsSync(grep[1] as string)) {
      return {
        id: `${grep[1]}:${grep[2]}`,
        text: (grep[3] as string).trim(),
        path: grep[1] as string,
        line: Number(grep[2]),
      };
    }
    if (opts.readFiles !== false && existsSync(entry) && statSync(entry).isFile()) {
      return { id: entry, text: readTextFile(entry), path: entry };
    }
    return { id: String(index), text: entry };
  }

  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : undefined;
    let text = typeof record.text === "string" ? record.text : undefined;
    if (text === undefined && path && opts.readFiles !== false && existsSync(path)) {
      text = readTextFile(path);
    }
    if (text === undefined) {
      throw usageError(
        `Candidate ${index} has no "text" and no readable "path".`,
        'Each JSON Lines candidate needs {"id"?, "text"} or {"path"}.',
      );
    }
    const id =
      typeof record.id === "string"
        ? record.id
        : typeof record.id === "number"
          ? String(record.id)
          : (path ?? String(index));
    return {
      id,
      text,
      ...(path ? { path } : {}),
      ...(typeof record.line === "number" ? { line: record.line } : {}),
    };
  }

  throw usageError(`Candidate ${index} must be a string or an object.`);
}
