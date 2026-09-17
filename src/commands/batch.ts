import type { EntryType, Questions } from "@typesafe-ai/sdk";
import { settledPool } from "../core/client.ts";
import { formatUsd } from "../core/cost.ts";
import { CliError, EXIT, gateError, usageError, type ExitCode } from "../core/exit.ts";
import { normalizeError } from "../core/errors.ts";
import { evaluateGates, validateGates } from "../core/gate.ts";
import { parseJson } from "../core/input.ts";
import { writeLine } from "../render/output.ts";
import type { CommandSpec } from "../router.ts";
import {
  GATE_FLAGS,
  QUESTION_FLAGS,
  bool,
  gatesFrom,
  loadQuestions,
  makeRunner,
  num,
  outputFrom,
  questionTypes,
  stdinText,
  str,
} from "./common.ts";
import { readFileSync } from "node:fs";

interface BatchItem {
  id: string;
  state: EntryType;
}

/** Parse one NDJSON line into an item. A line that is not JSON is used as literal state. */
function parseItem(line: string, index: number, idField: string): BatchItem {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"')) {
    return { id: String(index), state: trimmed };
  }
  const parsed = parseJson(trimmed, `line ${index + 1}`);
  if (typeof parsed === "string") return { id: String(index), state: parsed };
  if (Array.isArray(parsed)) return { id: String(index), state: parsed as EntryType };
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const rawId = record[idField];
    const id =
      typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : String(index);
    // An explicit `state` field wins; otherwise the whole object is the state, which is
    // what a line coming straight out of `jq -c` usually means.
    if (record.state !== undefined) return { id, state: record.state as EntryType };
    const { [idField]: _omit, ...rest } = record;
    return { id, state: rest as EntryType };
  }
  throw usageError(`Line ${index + 1} is not a usable state.`);
}

export const batch: CommandSpec = {
  name: "batch",
  group: "Core",
  summary: "Apply one question set to many states, as NDJSON",
  args: "[file]",
  description: `
Reads one state per line from stdin or a file and writes one result per line, in the
same order. Each line may be a JSON object with "id" and "state", a bare JSON value,
or plain text.

Each state is a separate request, because the API answers questions against one state
at a time. Requests run --concurrency at a time. A failing item becomes an error line
and the run continues, unless --fail-fast is set. The process exits 6 if any item
failed a gate, and 1 if any item errored.
`,
  flags: {
    ...QUESTION_FLAGS,
    "id-field": { type: "string", value: "<name>", description: "Object key holding the item id", default: "id" },
    "fail-fast": { type: "boolean", description: "Stop at the first failing item" },
    ...GATE_FLAGS,
  },
  examples: [
    `jq -c '.[] | {id, state: .body}' issues.json | tsai batch --questions triage.json`,
    `fd -e md docs | tsai batch -q '{"type":"noul","instructions":"Is this page out of date?"}' > flags.ndjson`,
  ],
  async run({ flags, positionals }) {
    const mode = outputFrom(flags);
    const runner = makeRunner(flags);
    const gates = gatesFrom(flags);
    const idField = str(flags, "id-field") ?? "id";

    const source = positionals[0];
    const text = source ? readFileSync(source, "utf8") : await stdinText();
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) {
      throw usageError("No input lines.", "Pipe NDJSON on stdin, or pass a file path.");
    }

    const questions: Questions = await loadQuestions(flags);
    validateGates(gates, questionTypes(questions));
    const items = lines.map((line, index) => parseItem(line, index, idField));

    // Validate every payload before sending any, so a malformed item cannot leave a
    // half-billed run behind.
    const payloads = items.map((item) => runner.buildPayload(item.state, questions, str(flags, "model")));

    if (bool(flags, "dry-run")) {
      for (const [index, payload] of payloads.entries()) {
        writeLine(JSON.stringify({ id: (items[index] as BatchItem).id, dry_run: true, body: payload }));
      }
      return;
    }

    let failures = 0;
    let gateFailures = 0;
    // The worst per-item failure decides the process exit code, so a batch that hit a
    // bad key still exits 3 rather than a generic error.
    let worstCode: ExitCode = EXIT.OK;
    const concurrency = num(flags, "concurrency") ?? runner.config.settings.concurrency;

    const results = await settledPool(payloads, concurrency, async (payload, index) =>
      runner.systemOne(payload).then((response) => ({ index, response })),
    );

    for (const [index, settled] of results.entries()) {
      const id = (items[index] as BatchItem).id;
      if (!settled.ok) {
        failures += 1;
        const { normalized, code } = normalizeError(settled.error);
        if (code > worstCode) worstCode = code;
        writeLine(JSON.stringify({ id, error: normalized }));
        if (bool(flags, "fail-fast")) break;
        continue;
      }
      const { response } = settled.value;
      const failed = evaluateGates(response.answers, gates);
      if (failed.length > 0) gateFailures += 1;
      writeLine(
        JSON.stringify({
          id,
          model: response.model,
          answers: response.answers,
          usage: response.usage,
          cached: response.cached,
          ...(failed.length > 0 ? { gate_failures: failed } : {}),
        }),
      );
    }

    if (!mode.quiet) {
      const summary = `${items.length} items · ${failures} failed · ${runner.cacheHits} cached · ${runner.cost.input_tokens} in · ${formatUsd(runner.cost.usd)}`;
      process.stderr.write(`${summary}\n`);
    }

    if (failures > 0) {
      throw new CliError(worstCode === EXIT.OK ? EXIT.INTERNAL : worstCode, `${failures} of ${items.length} items failed.`, {
        hint: "Each failing line carries its own error object on stdout.",
      });
    }
    if (gateFailures > 0) {
      throw gateError(`${gateFailures} of ${items.length} items failed a gate.`, { items: gateFailures });
    }
  },
};
