import { Painter, printField, printJson, writeLine } from "../render/output.ts";
import type { CommandSpec } from "../router.ts";
import { makeRunner, outputFrom } from "./common.ts";

export const models: CommandSpec = {
  name: "models",
  group: "Core",
  summary: "List the models your key can use",
  description: `
Model aliases resolve to a pinned version at request time. Every answer reports the
resolved id, so a result can be tied back to the exact model that produced it.
`,
  flags: {},
  examples: [`tsai models`, `tsai models --json | jq -r '.models[].name'`],
  async run({ flags }) {
    const mode = outputFrom(flags);
    const runner = makeRunner(flags);
    const cards = await runner.listModels();
    const document = { models: cards };

    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) return printJson(document, mode);

    const paint = new Painter(mode.color);
    writeLine("");
    const width = Math.max(...cards.map((card) => card.name.length)) + 2;
    for (const card of cards) {
      writeLine(`  ${paint.bold(card.name.padEnd(width))}${card.description}`);
      writeLine(`  ${" ".repeat(width)}${paint.dim(`released ${card.release_date}`)}`);
    }
    writeLine("");
  },
};
