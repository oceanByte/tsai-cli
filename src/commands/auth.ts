import { createInterface } from "node:readline";
import { clearApiKey, maskKey, resolveConfig, saveApiKey, userConfigPath } from "../core/config.ts";
import { CliError, EXIT, usageError } from "../core/exit.ts";
import { Painter, printField, printJson, writeLine } from "../render/output.ts";
import type { CommandSpec } from "../router.ts";
import { makeRunner, outputFrom, str, stdinText } from "./common.ts";

const CTRL_C = "\u0003";
const BACKSPACE = "\u007f";

/**
 * Read a secret from the terminal without echoing it.
 *
 * Falls back to a plain prompt when the terminal cannot be put into raw mode, which
 * is the case inside some CI shells. The key is never printed back either way.
 */
async function promptSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;
  output.write(prompt);

  if (typeof input.setRawMode !== "function") {
    const rl = createInterface({ input, output });
    const answer = await new Promise<string>((resolve) => rl.question("", resolve));
    rl.close();
    return answer.trim();
  }

  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const detach = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          detach();
          output.write("\n");
          resolve(buffer.trim());
          return;
        }
        if (char === CTRL_C) {
          detach();
          output.write("\n");
          reject(new CliError(EXIT.USAGE, "Cancelled."));
          return;
        }
        if (char === BACKSPACE) buffer = buffer.slice(0, -1);
        else buffer += char;
      }
    };
    input.on("data", onData);
  });
}

function looksLikeKey(key: string): boolean {
  return key.startsWith("apikey_") && key.length > 40;
}

export const auth: CommandSpec = {
  name: "auth",
  group: "Setup",
  summary: "Store, check, or remove the API key",
  args: "<login|status|logout>",
  description: `
login  stores the key in the user config file at mode 0600. Pass --key, pipe the key
       on stdin, or answer the hidden prompt. The key is never echoed or logged.
status verifies the stored key with a real request and reports which layer it came
       from. The key is shown masked.
logout removes the stored key, leaving other settings in place.

The environment variable TYPESAFE_API_KEY takes precedence over the stored key, which
is the right default for CI.
`,
  flags: {
    key: { type: "string", value: "<key>", description: "The key to store, for non-interactive use" },
  },
  examples: [
    `tsai auth login`,
    `tsai auth login --key "$TYPESAFE_API_KEY"`,
    `tsai auth status --field authenticated`,
  ],
  async run({ flags, positionals }) {
    const mode = outputFrom(flags);
    const action = positionals[0] ?? "status";
    const paint = new Painter(mode.color);

    if (action === "login") {
      let key = str(flags, "key");
      if (!key) {
        const piped = (await stdinText()).trim();
        key = piped || (process.stdin.isTTY ? await promptSecret("TypeSafe API key: ") : "");
      }
      if (!key) {
        throw usageError(
          "No API key supplied.",
          "Pass --key <key>, pipe it on stdin, or run this from a terminal to be prompted.",
        );
      }
      if (!looksLikeKey(key)) {
        throw usageError(
          "That does not look like a TypeSafe API key.",
          "Keys begin with `apikey_`. Copy it from https://typesafe.ai without surrounding quotes.",
        );
      }

      const path = saveApiKey(key);
      const document = { saved: true, path, key: maskKey(key) };
      if (mode.field) return printField(document, mode.field);
      if (!mode.pretty) return printJson(document, mode);
      writeLine(`Saved ${paint.bold(maskKey(key) as string)} to ${paint.dim(path)} (mode 0600).`);
      writeLine(paint.dim("Run `tsai auth status` to verify it."));
      return;
    }

    if (action === "logout") {
      const { path, removed } = clearApiKey();
      const document = { removed, path };
      if (mode.field) return printField(document, mode.field);
      if (!mode.pretty) return printJson(document, mode);
      writeLine(removed ? `Removed the stored key from ${paint.dim(path)}.` : "No stored key to remove.");
      return;
    }

    if (action !== "status") {
      throw usageError(`Unknown auth action "${action}".`, "Use one of: login, status, logout.");
    }

    const config = resolveConfig();
    const runner = makeRunner(flags);
    const key = runner.config.settings.apiKey;

    if (!key) {
      throw new CliError(EXIT.AUTH, "No API key configured.", {
        hint: "Run `tsai auth login`, or set TYPESAFE_API_KEY.",
        details: { authenticated: false, config_path: userConfigPath() },
      });
    }

    // A stored key the server rejects is worse than no key, so verify it for real.
    const cards = await runner.listModels();
    const document = {
      authenticated: true,
      key: maskKey(key),
      source: config.source.apiKey,
      base_url: runner.config.settings.baseURL,
      models: cards.map((card) => card.name),
    };
    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) return printJson(document, mode);
    writeLine(`${paint.green("authenticated")} as ${paint.bold(maskKey(key) as string)}`);
    writeLine(paint.dim(`  key from: ${config.source.apiKey} · host: ${runner.config.settings.baseURL}`));
    writeLine(paint.dim(`  models: ${cards.map((card) => card.name).join(", ")}`));
  },
};
