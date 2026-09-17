import { describe, expect, test } from "bun:test";
import { buildRegistry } from "../src/commands/index.ts";
import { CliError, EXIT } from "../src/core/exit.ts";
import { catalog, GLOBAL_FLAGS, parseCommandArgs, renderCommandHelp, renderRootHelp, type CommandSpec } from "../src/router.ts";
import { VERSION } from "../src/version.ts";

const spec: CommandSpec = {
  name: "demo",
  group: "Core",
  summary: "A command used only by the tests",
  flags: {
    instructions: { type: "string", short: "i", value: "<text>", description: "The question" },
    level: { type: "string", short: "l", multiple: true, value: "<text>", description: "A level" },
    width: { type: "number", value: "<n>", description: "How wide" },
    tree: { type: "boolean", description: "Walk a taxonomy" },
    unit: { type: "string", choices: ["file", "hunk"], value: "<unit>", description: "Split unit" },
  },
  examples: ["tsai demo -i 'x'"],
  run: async () => {},
};

const codeOf = (run: () => void): number | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof CliError ? error.code : EXIT.INTERNAL;
  }
};

describe("parseCommandArgs", () => {
  test("short and long forms produce the same value", () => {
    expect(parseCommandArgs(spec, ["-i", "hello"]).flags.instructions).toBe("hello");
    expect(parseCommandArgs(spec, ["--instructions", "hello"]).flags.instructions).toBe("hello");
  });

  test("a repeatable flag collects into an array even when given once", () => {
    expect(parseCommandArgs(spec, ["-l", "a", "-l", "b"]).flags.level).toEqual(["a", "b"]);
    expect(parseCommandArgs(spec, ["-l", "a"]).flags.level).toEqual(["a"]);
  });

  test("a number flag is coerced from its string form", () => {
    expect(parseCommandArgs(spec, ["--width", "3"]).flags.width).toBe(3);
  });

  test("a non-numeric value for a number flag is a usage error", () => {
    expect(codeOf(() => parseCommandArgs(spec, ["--width", "wide"]))).toBe(EXIT.USAGE);
  });

  test("a value outside a flag's choices is rejected before any request", () => {
    expect(parseCommandArgs(spec, ["--unit", "hunk"]).flags.unit).toBe("hunk");
    expect(codeOf(() => parseCommandArgs(spec, ["--unit", "paragraph"]))).toBe(EXIT.USAGE);
  });

  test("an unknown flag is reported rather than swallowed as a positional", () => {
    expect(codeOf(() => parseCommandArgs(spec, ["--nope"]))).toBe(EXIT.USAGE);
  });

  test("positionals are kept separate from flags", () => {
    const { positionals, flags } = parseCommandArgs(spec, ["a.txt", "-i", "x", "b.txt"]);
    expect(positionals).toEqual(["a.txt", "b.txt"]);
    expect(flags.instructions).toBe("x");
  });

  test("a repeated non-repeatable flag takes the last value", () => {
    expect(parseCommandArgs(spec, ["-i", "first", "-i", "second"]).flags.instructions).toBe("second");
  });

  test("an absent flag is omitted rather than set to undefined", () => {
    expect("width" in parseCommandArgs(spec, []).flags).toBe(false);
  });

  test("a boolean flag defaults to absent and is true when present", () => {
    expect(parseCommandArgs(spec, []).flags.tree).toBeUndefined();
    expect(parseCommandArgs(spec, ["--tree"]).flags.tree).toBe(true);
  });

  test("global flags are accepted on every command", () => {
    const { flags } = parseCommandArgs(spec, ["--json", "--field", "answers.a.noul", "--timeout", "1000"]);
    expect(flags).toMatchObject({ json: true, field: "answers.a.noul", timeout: 1000 });
  });
});

describe("help rendering", () => {
  test("command help carries usage, the examples and the exit code contract", () => {
    const help = renderCommandHelp(spec);
    expect(help).toContain("Usage: tsai demo");
    expect(help).toContain("tsai demo -i 'x'");
    expect(help).toContain("Exit codes:");
  });

  test("help text contains no em dash, per the project's writing rule", () => {
    const registry = buildRegistry();
    expect(renderRootHelp(registry, VERSION)).not.toContain("—");
    for (const command of registry.values()) {
      expect(renderCommandHelp(command)).not.toContain("—");
    }
  });

  test("root help lists every registered command under its group", () => {
    const registry = buildRegistry();
    const help = renderRootHelp(registry, VERSION);
    for (const name of registry.keys()) expect(help).toContain(name);
    for (const group of ["Core", "Recipes", "Setup"]) expect(help).toContain(`${group}:`);
  });
});

describe("catalog", () => {
  const document = catalog(buildRegistry(), VERSION) as {
    commands: { name: string; examples: string[]; flags: { name: string }[] }[];
    exit_codes: Record<string, string>;
    global_flags: { name: string }[];
  };

  test("the whole surface is machine-readable in one call", () => {
    expect(document.commands.length).toBeGreaterThan(10);
    expect(document.global_flags.map((f) => f.name)).toEqual(Object.keys(GLOBAL_FLAGS));
  });

  test("every exit code in the contract is documented", () => {
    expect(Object.keys(document.exit_codes).sort()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });

  test("every command carries at least one worked example", () => {
    for (const command of document.commands) {
      expect(command.examples.length).toBeGreaterThan(0);
    }
  });

  test("the catalog survives a JSON round trip, so agents can parse it", () => {
    expect(JSON.parse(JSON.stringify(document)).commands).toHaveLength(document.commands.length);
  });
});

describe("registry", () => {
  test("the core commands and the coding recipes are all registered", () => {
    const registry = buildRegistry();
    for (const name of ["ask", "noul", "choice", "score", "batch", "models", "auth", "config", "schema", "cache"]) {
      expect(registry.has(name)).toBe(true);
    }
    for (const name of ["rank", "find", "screen", "verify", "review", "classify", "extract"]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  test("a command's own flags never shadow a global flag name", () => {
    for (const command of buildRegistry().values()) {
      for (const name of Object.keys(command.flags)) {
        expect(Object.keys(GLOBAL_FLAGS)).not.toContain(name);
      }
    }
  });

  test("short flag letters are unique within each command", () => {
    for (const command of buildRegistry().values()) {
      const shorts = [...Object.values(command.flags), ...Object.values(GLOBAL_FLAGS)]
        .map((flag) => flag.short)
        .filter((short): short is string => short !== undefined);
      expect(new Set(shorts).size).toBe(shorts.length);
    }
  });
});
