import { usageError } from "../core/exit.ts";
import { printJson, writeLine } from "../render/output.ts";
import { catalog, renderCommandHelp, renderRootHelp, type CommandSpec } from "../router.ts";
import { VERSION } from "../version.ts";
import { bool, outputFrom } from "./common.ts";

export const help: CommandSpec = {
  name: "help",
  group: "Setup",
  summary: "Show help, or the whole command catalog as JSON",
  args: "[command]",
  description: `
With no arguments this prints the command list. With a command name it prints that
command's help, the same as passing --help to it.

--json emits every command, flag, default and exit code in one document. That is the
fastest way for an agent to learn this CLI: one call instead of one --help per
command.
`,
  flags: {},
  examples: [`tsai help`, `tsai help ask`, `tsai help --json | jq '.commands[].name'`],
  async run({ flags, positionals, registry }) {
    const mode = outputFrom(flags);
    const name = positionals[0];

    if (bool(flags, "json")) {
      if (name) {
        const command = registry.get(name);
        if (!command) throw usageError(`Unknown command "${name}".`);
        const single = new Map([[name, command]]);
        return printJson(catalog(single, VERSION), mode);
      }
      return printJson(catalog(registry, VERSION), mode);
    }

    if (name) {
      const command = registry.get(name);
      if (!command) {
        throw usageError(`Unknown command "${name}".`, `Run \`tsai help\` for the list.`);
      }
      writeLine(renderCommandHelp(command));
      return;
    }

    writeLine(renderRootHelp(registry, VERSION));
  },
};
