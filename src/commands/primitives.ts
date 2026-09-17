import type { ChoiceCriteria, EntryType, Questions, ScoreCriteria } from "@typesafe-ai/sdk";
import { usageError } from "../core/exit.ts";
import { enforceGates, validateGates } from "../core/gate.ts";
import { printResponse } from "../render/output.ts";
import type { CommandSpec } from "../router.ts";
import {
  GATE_FLAGS,
  STATE_FLAGS,
  bool,
  gatesFrom,
  list,
  loadState,
  makeRunner,
  maybeDryRun,
  outputFrom,
  questionTypes,
  required,
  str,
} from "./common.ts";

/**
 * The single-question shorthands.
 *
 * `ask` can express all of these, but writing question JSON on a command line is
 * error-prone. Each shorthand names its answer `answer`, so `--field answers.answer.noul`
 * is a stable way for a script to read the result.
 */
const ID = "answer";

/** Parse `label=description` pairs, tolerating a bare `label` for an undescribed option. */
export function parseLabelPairs(pairs: readonly string[]): ChoiceCriteria {
  const criteria: ChoiceCriteria = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    const label = (index === -1 ? pair : pair.slice(0, index)).trim();
    if (label === "") throw usageError(`Choice option "${pair}" has an empty label.`);
    if (label in criteria) throw usageError(`Choice option "${label}" was given twice.`);
    const description = index === -1 ? null : pair.slice(index + 1).trim();
    criteria[label] = description === null || description === "" ? null : description;
  }
  return criteria;
}

async function execute(
  flags: Record<string, unknown>,
  positionals: string[],
  questions: Questions,
): Promise<void> {
  const mode = outputFrom(flags);
  const runner = makeRunner(flags);
  const gates = gatesFrom(flags);
  const state: EntryType = await loadState(flags, positionals);
  const payload = runner.buildPayload(state, questions, str(flags, "model"));

  if (maybeDryRun(flags, payload, mode)) return;
  validateGates(gates, questionTypes(questions));

  const response = await runner.systemOne(payload);
  printResponse(response, runner.cost, mode);
  enforceGates(response.answers, gates);
}

export const noul: CommandSpec = {
  name: "noul",
  group: "Core",
  summary: "Ask one yes/no question and get a probability",
  args: "[file...]",
  description: `
Returns the probability that the condition holds, between 0 and 1.

A noul carries no confidence value: 0.5 means yes and no are equally likely, not
that the model is unsure at medium intensity. Use --min-noul or --max-noul to turn
the result into a check that exits 6.

Ask one condition per question. When several labels may apply at once, run one noul
per label in a single \`ask\` rather than forcing a choice.
`,
  flags: {
    instructions: { type: "string", short: "i", value: "<text>", description: "The condition to judge" },
    true: { type: "string", value: "<text>", description: "What a yes answer means" },
    false: { type: "string", value: "<text>", description: "What a no answer means" },
    ...STATE_FLAGS,
    ...GATE_FLAGS,
  },
  examples: [
    `tsai noul -i "Does this file contain a hardcoded secret?" src/config.ts`,
    `git diff | tsai noul -i "Does this change alter public API behaviour?" --max-noul 0.3`,
    `tsai noul -i "Is this a bug report?" --state "the page is blank after login" --field answers.answer.noul`,
  ],
  async run({ flags, positionals }) {
    const instructions = required(flags, "instructions", 'Example: -i "Does this text request credentials?"');
    const yes = str(flags, "true");
    const no = str(flags, "false");
    const criteria =
      yes !== undefined || no !== undefined
        ? { ...(yes !== undefined ? { true: yes } : {}), ...(no !== undefined ? { false: no } : {}) }
        : undefined;
    await execute(flags, positionals, {
      [ID]: { type: "noul", instructions, ...(criteria ? { criteria } : {}) },
    });
  },
};

export const choice: CommandSpec = {
  name: "choice",
  group: "Core",
  summary: "Pick one option from a named set",
  args: "[file...]",
  description: `
Returns the selected label, a confidence, and the probability of every option.

Options are given as -c label=description, repeatable. A description is optional but
usually earns its tokens, because it is what separates two labels that sound alike.
Add --none when the state may match nothing, so the model has somewhere to go.

At most 255 options are accepted by the API.
`,
  flags: {
    instructions: { type: "string", short: "i", value: "<text>", description: "The question to answer" },
    criterion: {
      type: "string",
      short: "c",
      multiple: true,
      value: "<label=description>",
      description: "An option, repeatable. The description may be omitted",
    },
    options: { type: "string", value: "<a,b,c>", description: "Undescribed options as a comma-separated list" },
    none: { type: "boolean", description: "Append a 'none' option for states that match nothing" },
    ...STATE_FLAGS,
    ...GATE_FLAGS,
  },
  examples: [
    `tsai choice -i "Which component owns this bug?" -c api="server endpoints" -c ui="React frontend" -c docs="written guides" report.txt`,
    `tsai choice -i "What kind of change is this?" --options feat,fix,chore,docs --none < commit.txt`,
    `tsai choice -i "Severity?" --options low,high report.txt --expect low   # exits 6 when high`,
  ],
  async run({ flags, positionals }) {
    const instructions = required(flags, "instructions", 'Example: -i "Which team should handle this?"');
    const pairs = list(flags, "criterion");
    const plain = (str(flags, "options") ?? "")
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label !== "");
    const criteria = parseLabelPairs([...pairs, ...plain]);

    if (bool(flags, "none")) {
      if ("none" in criteria) throw usageError('--none was given but a "none" option already exists.');
      criteria.none = "No other option applies to this state.";
    }
    if (Object.keys(criteria).length === 0) {
      throw usageError("No options supplied.", "Repeat -c label=description, or pass --options a,b,c.");
    }

    await execute(flags, positionals, { [ID]: { type: "choice", instructions, criteria } });
  },
};

export const score: CommandSpec = {
  name: "score",
  group: "Core",
  summary: "Rate along an ordered rubric",
  args: "[file...]",
  description: `
Returns a probability-weighted position across the levels, so the answer lands
between them: 1.94 on a three-level rubric means "almost entirely level 2".

Levels are given in order with -l, starting at index 0. Between 2 and 10 are
accepted. Each level must describe a concrete situation that stands on its own,
because the model sees the descriptions and not their index.
`,
  flags: {
    instructions: { type: "string", short: "i", value: "<text>", description: "The dimension to rate" },
    level: {
      type: "string",
      short: "l",
      multiple: true,
      value: "<text>",
      description: "A level description, repeated in order from lowest to highest",
    },
    ...STATE_FLAGS,
    ...GATE_FLAGS,
  },
  examples: [
    `tsai score -i "How severe is this bug?" -l "cosmetic" -l "degrades a feature" -l "data loss or outage" report.txt`,
    `tsai score -i "Readability of this function" -l "hard to follow" -l "workable" -l "clear" src/parse.ts --min-score 1.5`,
  ],
  async run({ flags, positionals }) {
    const instructions = required(flags, "instructions", 'Example: -i "How urgent is this?"');
    const levels = list(flags, "level");
    if (levels.length < 2) {
      throw usageError(
        `A score needs at least 2 levels; ${levels.length} given.`,
        'Repeat -l, lowest first: -l "no impact" -l "minor" -l "severe".',
      );
    }
    const criteria = levels as unknown as ScoreCriteria;
    await execute(flags, positionals, { [ID]: { type: "score", instructions, criteria } });
  },
};
