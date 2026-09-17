#!/usr/bin/env node
import { ALIASES, buildRegistry } from "./commands/index.ts";
import { normalizeError } from "./core/errors.ts";
import { EXIT, usageError } from "./core/exit.ts";
import { printError, resolveOutputMode, writeLine } from "./render/output.ts";
import { parseCommandArgs, renderCommandHelp, renderRootHelp } from "./router.ts";
import { VERSION } from "./version.ts";

// A closed pipe (`tsai help | head -5`) is not a failure worth reporting.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(EXIT.OK);
  throw error;
});

/** Levenshtein distance, used only to suggest a command after a typo. */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = rows[0] as number;
    rows[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = rows[j] as number;
      rows[j] = Math.min(
        (rows[j] as number) + 1,
        (rows[j - 1] as number) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = temp;
    }
  }
  return rows[b.length] as number;
}

function suggest(name: string, known: readonly string[]): string | undefined {
  const ranked = known
    .map((candidate) => ({ candidate, score: distance(name, candidate) }))
    .sort((a, b) => a.score - b.score);
  const best = ranked[0];
  return best && best.score <= 3 ? best.candidate : undefined;
}

async function main(argv: string[]): Promise<number> {
  const registry = buildRegistry();
  const [first, ...rest] = argv;

  if (first === undefined || first === "--help" || first === "-h") {
    writeLine(renderRootHelp(registry, VERSION));
    return EXIT.OK;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    writeLine(VERSION);
    return EXIT.OK;
  }

  // An alias may expand to a command plus its subaction, so `tsai login` reaches
  // `tsai auth login`.
  const expansion = ALIASES[first] ?? [first];
  const name = expansion[0] as string;
  const args = [...expansion.slice(1), ...rest];

  const command = registry.get(name);
  if (!command) {
    const hint = suggest(name, [...registry.keys()]);
    throw usageError(
      `Unknown command "${first}".`,
      hint
        ? `Did you mean \`tsai ${hint}\`? Run \`tsai help\` for the list.`
        : "Run `tsai help` for the list.",
    );
  }

  const { flags, positionals } = parseCommandArgs(command, args);
  if (flags.help === true) {
    writeLine(renderCommandHelp(command));
    return EXIT.OK;
  }

  await command.run({ flags, positionals, command, registry });
  return EXIT.OK;
}

const argv = process.argv.slice(2);

try {
  process.exitCode = await main(argv);
} catch (error) {
  const { normalized, code } = normalizeError(error);
  // Errors are rendered the same way results are: readable for a person at a
  // terminal, JSON for anything reading the stream.
  printError(
    normalized,
    resolveOutputMode({
      json: argv.includes("--json"),
      pretty: argv.includes("--pretty"),
      quiet: argv.includes("--quiet"),
    }),
  );
  process.exitCode = code;
}
