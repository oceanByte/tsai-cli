import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { usageError } from "./exit.ts";

/** Where a resolved setting came from. Reported by `tsai config`. */
export type Source = "flag" | "env" | "project" | "user" | "default";

export interface Settings {
  apiKey?: string;
  baseURL: string;
  model: string;
  /** Per-attempt timeout in milliseconds. */
  timeout: number;
  /** Retries after the first attempt. */
  retries: number;
  /** Parallel in-flight requests for commands that fan out over many items. */
  concurrency: number;
  cache: boolean;
}

export type Provenance = { [K in keyof Settings]: Source };

export interface ResolvedConfig {
  settings: Settings;
  source: Provenance;
  /** Config files that were actually found and read, in precedence order. */
  files: string[];
}

/**
 * SDK defaults are inherited except for the timeout: the SDK ships 10 s, which is too
 * tight for a large state carrying many questions, so the CLI raises it to 60 s.
 */
const DEFAULTS: Settings = {
  baseURL: "https://api.typesafe.ai",
  model: "jev-latest",
  timeout: 60_000,
  retries: 2,
  concurrency: 8,
  cache: true,
};

const PROJECT_FILES = ["tsai.config.json", ".tsai.json"];

/** Config directory, honoring XDG_CONFIG_HOME on Linux and BSD. */
export function userConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return join(xdg, "tsai");
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "tsai");
  }
  return join(homedir(), ".config", "tsai");
}

export const userConfigPath = (): string => join(userConfigDir(), "config.json");

export function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && xdg.trim()) return join(xdg, "tsai-cli");
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "tsai-cli");
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "tsai-cli", "cache");
  }
  return join(homedir(), ".cache", "tsai-cli");
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw usageError(
      `Could not read config file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Find the nearest project config by walking up from cwd toward the filesystem root. */
function findProjectConfig(from: string): { path: string; data: Record<string, unknown> } | undefined {
  let dir = resolve(from);
  for (;;) {
    for (const name of PROJECT_FILES) {
      const candidate = join(dir, name);
      const data = readJsonFile(candidate);
      if (data) return { path: candidate, data };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface ConfigOverrides {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  timeout?: number;
  retries?: number;
  concurrency?: number;
  cache?: boolean;
}

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

/**
 * Resolve settings across the precedence chain: flags, environment, project config,
 * user config, then built-in defaults. Records which layer won for each key so
 * `tsai config` can explain itself.
 */
export function resolveConfig(overrides: ConfigOverrides = {}, cwd = process.cwd()): ResolvedConfig {
  const settings: Settings = { ...DEFAULTS };
  const source = {
    apiKey: "default",
    baseURL: "default",
    model: "default",
    timeout: "default",
    retries: "default",
    concurrency: "default",
    cache: "default",
  } as Provenance;
  const files: string[] = [];

  const user = readJsonFile(userConfigPath());
  if (user) files.push(userConfigPath());
  const project = findProjectConfig(cwd);
  if (project) files.push(project.path);

  // Lowest precedence first, so later layers overwrite earlier ones.
  const layers: Array<{ name: Source; data: Record<string, unknown> | undefined }> = [
    { name: "user", data: user },
    { name: "project", data: project?.data },
    {
      name: "env",
      data: {
        apiKey: process.env.TYPESAFE_API_KEY,
        baseURL: process.env.TYPESAFE_BASE_URL,
        model: process.env.TYPESAFE_DEFAULT_MODEL,
        timeout: process.env.TYPESAFE_TIMEOUT,
        retries: process.env.TYPESAFE_RETRIES,
        concurrency: process.env.TYPESAFE_CONCURRENCY,
        cache: process.env.TYPESAFE_CACHE,
      },
    },
    { name: "flag", data: overrides as Record<string, unknown> },
  ];

  for (const layer of layers) {
    const data = layer.data;
    if (!data) continue;
    const put = <K extends keyof Settings>(key: K, value: Settings[K] | undefined) => {
      if (value === undefined) return;
      settings[key] = value;
      source[key] = layer.name;
    };
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

    put("apiKey", str(data.apiKey));
    put("baseURL", str(data.baseURL));
    put("model", str(data.model ?? data.defaultModel));
    put("timeout", asNumber(data.timeout));
    put("retries", asNumber(data.retries));
    put("concurrency", asNumber(data.concurrency));
    if (typeof data.cache === "boolean") put("cache", data.cache);
    else if (typeof data.cache === "string" && data.cache.trim() !== "") {
      put("cache", !/^(0|false|no|off)$/i.test(data.cache.trim()));
    }
  }

  if (settings.timeout <= 0) throw usageError("--timeout must be greater than 0.");
  if (settings.retries < 0) throw usageError("--retries cannot be negative.");
  if (settings.concurrency < 1) throw usageError("--concurrency must be at least 1.");

  return { settings, source, files };
}

export function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 12) return "***";
  return `${key.slice(0, 11)}…${key.slice(-4)}`;
}

/** Persist the API key to the user config at mode 0600, preserving other settings. */
export function saveApiKey(apiKey: string): string {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existing = existsSync(path) ? (readJsonFile(path) ?? {}) : {};
  const next = { ...existing, apiKey };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Remove only the stored key, leaving other user settings intact. */
export function clearApiKey(): { path: string; removed: boolean } {
  const path = userConfigPath();
  if (!existsSync(path)) return { path, removed: false };
  const existing = readJsonFile(path) ?? {};
  if (!("apiKey" in existing)) return { path, removed: false };
  delete existing.apiKey;
  if (Object.keys(existing).length === 0) rmSync(path);
  else writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  return { path, removed: true };
}
