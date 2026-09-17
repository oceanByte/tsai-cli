import type { CommandSpec, Registry } from "../router.ts";
import { ask } from "./ask.ts";
import { auth } from "./auth.ts";
import { batch } from "./batch.ts";
import { cache } from "./cache.ts";
import { config } from "./config.ts";
import { help } from "./help.ts";
import { models } from "./models.ts";
import { choice, noul, score } from "./primitives.ts";
import { classify } from "./recipes/classify.ts";
import { extract } from "./recipes/extract.ts";
import { find } from "./recipes/find.ts";
import { rank } from "./recipes/rank.ts";
import { review } from "./recipes/review.ts";
import { screen } from "./recipes/screen.ts";
import { verify } from "./recipes/verify.ts";
import { schema } from "./schema.ts";

/** Listed in the order they appear in help, which is roughly the order to learn them. */
const COMMANDS: CommandSpec[] = [
  ask,
  noul,
  choice,
  score,
  batch,
  models,
  rank,
  find,
  screen,
  verify,
  review,
  classify,
  extract,
  auth,
  config,
  schema,
  cache,
  help,
];

export function buildRegistry(): Registry {
  const registry: Registry = new Map();
  for (const command of COMMANDS) registry.set(command.name, command);
  return registry;
}

/**
 * Names people reach for, expanded into a command and any subaction.
 *
 * `tsai login` is what someone types; `tsai auth login` is what it means.
 */
export const ALIASES: Record<string, string[]> = {
  login: ["auth", "login"],
  logout: ["auth", "logout"],
  whoami: ["auth", "status"],
  ls: ["models"],
  rerank: ["rank"],
  search: ["find"],
  grep: ["find"],
  lint: ["review"],
  guard: ["screen"],
  check: ["verify"],
  label: ["classify"],
  categorize: ["classify"],
};
