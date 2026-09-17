import { printJson, writeLine } from "../render/output.ts";
import { usageError } from "../core/exit.ts";
import { LIMITS } from "../core/validate.ts";
import type { CommandSpec } from "../router.ts";
import { bool, outputFrom } from "./common.ts";

/**
 * JSON Schema for a questions file.
 *
 * Published so an agent can author a valid question set without guessing, and so
 * editors with schema support can validate one while it is being written.
 */
const QUESTIONS_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://typesafe.ai/schemas/questions.json",
  title: "TypeSafe questions",
  description:
    "A map of question ids to questions. Ids are used by your code to read answers and are not shown to the model, so each question must carry its full meaning.",
  type: "object",
  minProperties: 1,
  additionalProperties: { $ref: "#/definitions/question" },
  definitions: {
    entry: {
      description: "Text, a JSON object, a JSON array, or null.",
      anyOf: [{ type: "string" }, { type: "object" }, { type: "array" }, { type: "null" }],
    },
    question: { oneOf: [{ $ref: "#/definitions/noul" }, { $ref: "#/definitions/choice" }, { $ref: "#/definitions/score" }] },
    noul: {
      title: "noul",
      description:
        "Probability that a condition holds, from 0 to 1. Returns no confidence value. Use one noul per label when several labels may apply at once.",
      type: "object",
      required: ["type"],
      properties: {
        type: { const: "noul" },
        instructions: { $ref: "#/definitions/entry" },
        criteria: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            true: { $ref: "#/definitions/entry", description: "What a yes answer means." },
            false: { $ref: "#/definitions/entry", description: "What a no answer means." },
          },
        },
      },
      additionalProperties: false,
    },
    choice: {
      title: "choice",
      description:
        "Selects exactly one label. Returns the label, a confidence, and a probability per label. Include a no-match label when the state may fit none of them.",
      type: "object",
      required: ["type", "criteria"],
      properties: {
        type: { const: "choice" },
        instructions: { $ref: "#/definitions/entry" },
        criteria: {
          type: "object",
          description: "Labels mapped to descriptions. A null description leaves the label undescribed.",
          minProperties: 2,
          maxProperties: LIMITS.MAX_CHOICE_OPTIONS,
          additionalProperties: { $ref: "#/definitions/entry" },
        },
      },
      additionalProperties: false,
    },
    score: {
      title: "score",
      description:
        "Rates along an ordered rubric. Returns a probability-weighted position that can fall between levels, plus a confidence and the rubric as a legend.",
      type: "object",
      required: ["type", "criteria"],
      properties: {
        type: { const: "score" },
        instructions: { $ref: "#/definitions/entry" },
        criteria: {
          type: "array",
          description: "Level descriptions in order, lowest first. Each must describe a concrete situation.",
          minItems: LIMITS.MIN_SCORE_LEVELS,
          maxItems: LIMITS.MAX_SCORE_LEVELS,
          items: { $ref: "#/definitions/entry" },
        },
      },
      additionalProperties: false,
    },
  },
} as const;

const EXAMPLE = {
  is_actionable: {
    type: "noul",
    instructions: "Does this report describe a reproducible problem someone could act on?",
    criteria: {
      true: "It names what happened, and enough context to attempt a reproduction.",
      false: "It is a question, an opinion, or too vague to act on.",
    },
  },
  area: {
    type: "choice",
    instructions: "Which part of the product does this report concern?",
    criteria: {
      api: "Server endpoints, authentication, or data returned to clients.",
      ui: "Rendering, layout, or interaction in the web interface.",
      billing: "Plans, invoices, payment methods, or usage limits.",
      none: "The report does not concern any of these areas.",
    },
  },
  severity: {
    type: "score",
    instructions: "How severe is the impact described?",
    criteria: [
      "Cosmetic. Nothing is blocked and no data is affected.",
      "A feature is degraded but a workaround exists.",
      "Data is lost or the product is unusable for the reporter.",
    ],
  },
} as const;

export const schema: CommandSpec = {
  name: "schema",
  group: "Setup",
  summary: "Print the JSON Schema for a questions file",
  description: `
Emits the schema a --questions file must satisfy, including the server limits this
CLI enforces locally: at most ${LIMITS.MAX_CHOICE_OPTIONS} choice options, and between
${LIMITS.MIN_SCORE_LEVELS} and ${LIMITS.MAX_SCORE_LEVELS} score levels.

Use --example for a filled-in question set that exercises all three primitives.
`,
  flags: {
    example: { type: "boolean", description: "Print an example questions file instead of the schema" },
    "schema-url": { type: "boolean", description: "Print the $id only, for use in a $schema key" },
  },
  examples: [
    `tsai schema > questions.schema.json`,
    `tsai schema --example > triage.json && tsai ask report.txt --questions triage.json`,
  ],
  async run({ flags }) {
    const mode = outputFrom(flags);
    if (bool(flags, "example") && bool(flags, "schema-url")) {
      throw usageError("--example and --schema-url cannot be used together.");
    }
    if (bool(flags, "schema-url")) {
      writeLine(QUESTIONS_SCHEMA.$id);
      return;
    }
    printJson(bool(flags, "example") ? EXAMPLE : QUESTIONS_SCHEMA, mode);
  },
};
