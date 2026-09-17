import { cacheStats, clearCache } from "../core/cache.ts";
import { usageError } from "../core/exit.ts";
import { Painter, printField, printJson, writeLine } from "../render/output.ts";
import type { CommandSpec } from "../router.ts";
import { outputFrom } from "./common.ts";

const human = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const cache: CommandSpec = {
  name: "cache",
  group: "Setup",
  summary: "Inspect or empty the local response cache",
  args: "<stats|clear|path>",
  description: `
Responses are cached under a hash of the complete request body plus the API host.
Any change to the state, the questions, or the model is a different key, so a stale
hit is not possible and the cache is safe to leave on. Entries expire after 7 days.

Pass --no-cache on any command to bypass it for that run.
`,
  flags: {},
  examples: [`tsai cache stats`, `tsai cache clear`],
  async run({ flags, positionals }) {
    const mode = outputFrom(flags);
    const action = positionals[0] ?? "stats";

    if (action === "path") {
      writeLine(cacheStats().dir);
      return;
    }

    if (action === "clear") {
      const removed = clearCache();
      const document = { cleared: true, entries_removed: removed };
      if (mode.field) return printField(document, mode.field);
      if (!mode.pretty) return printJson(document, mode);
      writeLine(`Removed ${removed} cached response${removed === 1 ? "" : "s"}.`);
      return;
    }

    if (action !== "stats") {
      throw usageError(`Unknown cache action "${action}".`, "Use one of: stats, clear, path.");
    }

    const stats = cacheStats();
    const document = { entries: stats.entries, bytes: stats.bytes, dir: stats.dir };
    if (mode.field) return printField(document, mode.field);
    if (!mode.pretty) return printJson(document, mode);

    const paint = new Painter(mode.color);
    writeLine("");
    writeLine(`  ${paint.bold("entries")}  ${stats.entries}`);
    writeLine(`  ${paint.bold("size")}     ${human(stats.bytes)}`);
    writeLine(`  ${paint.bold("path")}     ${paint.dim(stats.dir)}`);
    writeLine("");
  },
};
