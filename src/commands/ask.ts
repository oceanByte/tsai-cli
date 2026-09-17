import type { Questions } from "@typesafe-ai/sdk";
import type { SystemOnePayload } from "../core/client.ts";
import { usageError } from "../core/exit.ts";
import { enforceGates, validateGates } from "../core/gate.ts";
import { parseJson } from "../core/input.ts";
import { printResponse } from "../render/output.ts";
import type { CommandSpec } from "../router.ts";
import {
  GATE_FLAGS,
  QUESTION_FLAGS,
  STATE_FLAGS,
  gatesFrom,
  loadQuestions,
  loadState,
  makeRunner,
  maybeDryRun,
  outputFrom,
  questionTypes,
  str,
  stdinText,
} from "./common.ts";
import { readFileSync } from "node:fs";

/** Load a complete request body for --raw, from a file, stdin, or an inline literal. */
async function loadRawBody(source: string): Promise<SystemOnePayload> {
  const text =
    source === "-" ? await stdinText() : source.trimStart().startsWith("{") ? source : readFileSync(source, "utf8");
  const body = parseJson(text, "--raw body") as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw usageError("--raw must be a JSON object holding a complete request body.");
  }
  if (body.state === undefined) throw usageError('--raw body is missing "state".');
  if (body.questions === undefined) throw usageError('--raw body is missing "questions".');
  return body as unknown as SystemOnePayload;
}

export const ask: CommandSpec = {
  name: "ask",
  group: "Core",
  summary: "Ask arbitrary questions about some state",
  args: "[file...]",
  description: `
The full POST /v1/systemone endpoint. State comes from file arguments, --state,
--state-file, --state-json, or stdin. Questions come from a JSON file, repeated
inline --question values, or stdin.

Every question in one call is answered against the same state in a single request,
so adding questions costs only their own tokens. Prefer one call with many questions
over many calls with one.
`,
  flags: {
    ...STATE_FLAGS,
    ...QUESTION_FLAGS,
    raw: {
      type: "string",
      value: "<path|json|->",
      description: "Send a complete request body verbatim, bypassing local assembly",
    },
    ...GATE_FLAGS,
  },
  examples: [
    `tsai ask src/auth.ts -q '{"type":"noul","instructions":"Does this handle token expiry?"}'`,
    `tsai ask --state "The checkout button is greyed out" --questions triage.json`,
    `echo "$DIFF" | tsai ask -q '{"type":"choice","instructions":"Which area?","criteria":{"api":null,"ui":null,"docs":null}}' --field answers.q1.choice`,
    `tsai ask README.md --questions q.json --min-confidence 0.7   # exits 6 when unsure`,
  ],
  async run({ flags, positionals }) {
    const mode = outputFrom(flags);
    const runner = makeRunner(flags);
    const gates = gatesFrom(flags);

    const raw = str(flags, "raw");
    let payload: SystemOnePayload;
    let questions: Questions;

    if (raw !== undefined) {
      // --raw is deliberately not validated locally: a future API capability must never
      // be gated behind this CLI knowing about it.
      payload = await loadRawBody(raw);
      payload.model ??= runner.config.settings.model;
      if (str(flags, "model")) payload.model = str(flags, "model") as string;
      questions = payload.questions;
    } else {
      const state = await loadState(flags, positionals);
      questions = await loadQuestions(flags);
      payload = runner.buildPayload(state, questions, str(flags, "model"));
    }

    if (maybeDryRun(flags, payload, mode)) return;
    validateGates(gates, questionTypes(questions));

    const response = await runner.systemOne(payload);
    printResponse(response, runner.cost, mode);
    enforceGates(response.answers, gates);
  },
};
