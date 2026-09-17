import { parseArgs, type ParseArgsConfig } from "node:util";
import { usageError } from "./core/exit.ts";

/**
 * A minimal subcommand router over node:util parseArgs.
 *
 * Hand-rolled rather than pulled from npm so the published package carries exactly
 * one runtime dependency. It provides what a CLI of this size needs: per-command
 * flags, generated help, and a machine-readable catalog of the whole surface.
 */

export type FlagType = "string" | "boolean" | "number";

export interface FlagSpec {
  type: FlagType;
  /** Single-character alias, e.g. `i` for --instructions. */
  short?: string;
  /** Allowed more than once, collected into an array. */
  multiple?: boolean;
  description: string;
  /** Placeholder shown in help, e.g. `<path>`. */
  value?: string;
  /** Default rendered in help. Not applied automatically. */
  default?: string;
  /** Restrict to a fixed set of values, validated after parsing. */
  choices?: readonly string[];
}

export interface CommandSpec {
  name: string;
  /** One-line description shown in the command list. */
  summary: string;
  /** Longer description shown in the command's own help. */
  description?: string;
  /** Positional argument shape, e.g. `[file...]`. */
  args?: string;
  flags: Record<string, FlagSpec>;
  /** Worked invocations. Every command carries at least two. */
  examples: string[];
  /** Grouping label in the top-level help. */
  group: "Core" | "Recipes" | "Setup";
  run: (ctx: CommandContext) => Promise<void>;
}

export interface CommandContext {
  /** Parsed flag values, already type-coerced and validated. */
  flags: Record<string, unknown>;
  /** Remaining positional arguments. */
  positionals: string[];
  /** The command being run, for error messages and help. */
  command: CommandSpec;
  /** Every registered command, for `help`. */
  registry: Registry;
}

export type Registry = Map<string, CommandSpec>;

/** Flags accepted by every command. Merged into each command's own flag set. */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: "boolean", description: "Force JSON output even on a terminal" },
  pretty: { type: "boolean", description: "Force human-readable output even when piped" },
  quiet: { type: "boolean", short: "Q", description: "Suppress the model and cost footer" },
  field: { type: "string", value: "<path>", description: "Print one value, e.g. answers.severity.score" },
  model: { type: "string", value: "<name>", description: "Model to use", default: "jev-latest" },
  "api-key": { type: "string", value: "<key>", description: "API key (prefer TYPESAFE_API_KEY)" },
  "base-url": { type: "string", value: "<url>", description: "API root", default: "https://api.typesafe.ai" },
  timeout: { type: "number", value: "<ms>", description: "Per-attempt timeout", default: "60000" },
  retries: { type: "number", value: "<n>", description: "Retries after the first attempt", default: "2" },
  concurrency: { type: "number", value: "<n>", description: "Parallel requests when fanning out", default: "8" },
  "no-cache": { type: "boolean", description: "Bypass the local response cache" },
  "dry-run": { type: "boolean", description: "Print the request that would be sent, without sending it" },
  help: { type: "boolean", short: "h", description: "Show help for this command" },
};

/** Flags that only make sense on the root invocation. */
export const ROOT_FLAGS: Record<string, FlagSpec> = {
  version: { type: "boolean", short: "v", description: "Print the CLI version" },
  help: { type: "boolean", short: "h", description: "Show help" },
};

function toParseArgsOptions(flags: Record<string, FlagSpec>): ParseArgsConfig["options"] {
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const [name, spec] of Object.entries(flags)) {
    options[name] = {
      // parseArgs has no number type; parse as string and coerce afterwards.
      type: spec.type === "boolean" ? "boolean" : "string",
      ...(spec.short ? { short: spec.short } : {}),
      ...(spec.multiple ? { multiple: true } : {}),
    };
  }
  return options;
}

function coerce(name: string, spec: FlagSpec, raw: unknown): unknown {
  if (raw === undefined) return undefined;

  if (spec.multiple) {
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((item) => coerceOne(name, spec, item));
  }
  // parseArgs returns an array when a non-multiple flag is repeated; take the last.
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return coerceOne(name, spec, value);
}

function coerceOne(name: string, spec: FlagSpec, value: unknown): unknown {
  if (spec.type === "boolean") return Boolean(value);
  const text = String(value);
  if (spec.type === "number") {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) throw usageError(`--${name} expects a number, got "${text}".`);
    return parsed;
  }
  if (spec.choices && !spec.choices.includes(text)) {
    throw usageError(`--${name} expects one of: ${spec.choices.join(", ")}. Got "${text}".`);
  }
  return text;
}

export function parseCommandArgs(
  command: CommandSpec,
  argv: string[],
): { flags: Record<string, unknown>; positionals: string[] } {
  const flags = { ...GLOBAL_FLAGS, ...command.flags };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: toParseArgsOptions(flags),
      allowPositionals: true,
      // Surface unknown flags rather than silently treating them as positionals.
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw usageError(message, `Run \`tsai ${command.name} --help\` to see accepted flags.`);
  }

  const values: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(flags)) {
    const coerced = coerce(name, spec, (parsed.values as Record<string, unknown>)[name]);
    if (coerced !== undefined) values[name] = coerced;
  }
  return { flags: values, positionals: parsed.positionals as string[] };
}

const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + " ".repeat(width - text.length);

function flagUsage(name: string, spec: FlagSpec): string {
  const short = spec.short ? `-${spec.short}, ` : "    ";
  const value = spec.type === "boolean" ? "" : ` ${spec.value ?? "<value>"}`;
  return `${short}--${name}${value}`;
}

export function renderCommandHelp(command: CommandSpec): string {
  const lines: string[] = [];
  lines.push(`tsai ${command.name}: ${command.summary}`);
  lines.push("");
  lines.push(`Usage: tsai ${command.name} [options]${command.args ? ` ${command.args}` : ""}`);
  if (command.description) {
    lines.push("");
    lines.push(command.description.trim());
  }

  const render = (title: string, flags: Record<string, FlagSpec>) => {
    const entries = Object.entries(flags);
    if (entries.length === 0) return;
    lines.push("");
    lines.push(`${title}:`);
    const width = Math.max(...entries.map(([n, s]) => flagUsage(n, s).length)) + 2;
    for (const [name, spec] of entries) {
      const suffix = spec.default ? ` (default: ${spec.default})` : "";
      const choices = spec.choices ? ` [${spec.choices.join("|")}]` : "";
      lines.push(`  ${pad(flagUsage(name, spec), width)}${spec.description}${choices}${suffix}`);
    }
  };

  render("Options", command.flags);
  render("Common options", GLOBAL_FLAGS);

  lines.push("");
  lines.push("Examples:");
  for (const example of command.examples) lines.push(`  ${example}`);
  lines.push("");
  lines.push("Exit codes: 0 ok · 2 usage · 3 auth · 4 rate limit · 5 server · 6 gate not met · 7 connection");
  return lines.join("\n");
}

export function renderRootHelp(registry: Registry, version: string): string {
  const lines: string[] = [];
  lines.push(`tsai ${version}: typed judgments from the TypeSafe System One API.`);
  lines.push("");
  lines.push("An unofficial client for testing and prototyping. Not built, endorsed or");
  lines.push("supported by TypeSafe. Report bugs to this project, never to them.");
  lines.push("");
  lines.push("Usage: tsai <command> [options]");

  for (const group of ["Core", "Recipes", "Setup"] as const) {
    const entries = [...registry.values()].filter((c) => c.group === group);
    if (entries.length === 0) continue;
    lines.push("");
    lines.push(`${group}:`);
    const width = Math.max(...entries.map((c) => c.name.length)) + 4;
    for (const command of entries) {
      lines.push(`  ${pad(command.name, width)}${command.summary}`);
    }
  }

  lines.push("");
  lines.push("Run `tsai <command> --help` for details, or `tsai help --json` for the full");
  lines.push("machine-readable catalog of commands and flags.");
  lines.push("");
  lines.push("Set TYPESAFE_API_KEY, or run `tsai auth login`, before the first request.");
  return lines.join("\n");
}

/**
 * The whole command surface as JSON.
 *
 * An agent can learn every command, flag and exit code in one call instead of
 * reading prose help page by page.
 */
export function catalog(registry: Registry, version: string): unknown {
  return {
    name: "tsai",
    version,
    official: false,
    vendor_affiliation:
      "None. An unofficial third-party client for the TypeSafe System One API, built for testing and prototyping. Not endorsed or supported by TypeSafe.",
    exit_codes: {
      "0": "success",
      "1": "internal error",
      "2": "usage error, nothing was billed",
      "3": "authentication or permission denied",
      "4": "rate limited after retries",
      "5": "server error",
      "6": "gate not met",
      "7": "connection failure or timeout",
    },
    global_flags: Object.entries(GLOBAL_FLAGS).map(([name, spec]) => ({ name, ...spec })),
    commands: [...registry.values()].map((command) => ({
      name: command.name,
      group: command.group,
      summary: command.summary,
      description: command.description?.trim(),
      args: command.args,
      flags: Object.entries(command.flags).map(([name, spec]) => ({ name, ...spec })),
      examples: command.examples,
    })),
  };
}
