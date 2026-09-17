import { maskKey, resolveConfig, userConfigPath } from "../core/config.ts";
import { Painter, printField, printJson, writeLine } from "../render/output.ts";
import type { CommandSpec } from "../router.ts";
import { bool, num, outputFrom, str } from "./common.ts";

export const config: CommandSpec = {
  name: "config",
  group: "Setup",
  summary: "Show resolved settings and where each came from",
  description: `
Settings resolve in this order, highest first:

  1. command-line flags
  2. environment: TYPESAFE_API_KEY, TYPESAFE_BASE_URL, TYPESAFE_DEFAULT_MODEL,
     TYPESAFE_TIMEOUT, TYPESAFE_RETRIES, TYPESAFE_CONCURRENCY, TYPESAFE_CACHE
  3. the nearest tsai.config.json or .tsai.json, searching upward from the
     working directory
  4. the user config file
  5. built-in defaults

The API key is always masked. Flags passed to this command are reflected in the
output, so it doubles as a way to check what a given invocation would use.
`,
  flags: {},
  examples: [
    `tsai config`,
    `tsai config --model jev-preview --json   # preview what that flag resolves to`,
  ],
  async run({ flags }) {
    const mode = outputFrom(flags);
    const overrides = {
      ...(str(flags, "api-key") ? { apiKey: str(flags, "api-key") as string } : {}),
      ...(str(flags, "base-url") ? { baseURL: str(flags, "base-url") as string } : {}),
      ...(str(flags, "model") ? { model: str(flags, "model") as string } : {}),
      ...(num(flags, "timeout") !== undefined ? { timeout: num(flags, "timeout") as number } : {}),
      ...(num(flags, "retries") !== undefined ? { retries: num(flags, "retries") as number } : {}),
      ...(num(flags, "concurrency") !== undefined ? { concurrency: num(flags, "concurrency") as number } : {}),
      ...(bool(flags, "no-cache") ? { cache: false } : {}),
    };
    const resolved = resolveConfig(overrides);

    const document = {
      settings: { ...resolved.settings, apiKey: maskKey(resolved.settings.apiKey) ?? null },
      source: resolved.source,
      files: resolved.files,
      user_config_path: userConfigPath(),
    };

    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) return printJson(document, mode);

    const paint = new Painter(mode.color);
    const rows = Object.entries(document.settings);
    const width = Math.max(...rows.map(([key]) => key.length)) + 2;
    writeLine("");
    for (const [key, value] of rows) {
      const source = resolved.source[key as keyof typeof resolved.source];
      const shown = value === null ? paint.dim("(not set)") : String(value);
      writeLine(`  ${paint.bold(key.padEnd(width))}${shown}  ${paint.dim(`[${source}]`)}`);
    }
    writeLine("");
    writeLine(paint.dim(`  config files read: ${resolved.files.length > 0 ? resolved.files.join(", ") : "none"}`));
    writeLine("");
  },
};
