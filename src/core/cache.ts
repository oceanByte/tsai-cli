import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./config.ts";

/**
 * Content-addressed response cache.
 *
 * The key covers the entire request payload and the model name, so a changed state or
 * a reworded question is a different key. That makes stale hits structurally
 * impossible and lets the cache stay on by default: an agent re-running the same
 * command in a loop stops paying twice for an identical judgment.
 */

/** Serialize with object keys sorted at every depth, so key order cannot change the hash. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function cacheKey(payload: unknown, baseURL: string): string {
  return createHash("sha256").update(`${baseURL} ${canonicalize(payload)}`).digest("hex");
}

interface CacheEntry<T> {
  /** Unix milliseconds the entry was written. */
  at: number;
  value: T;
}

export class ResponseCache {
  readonly dir: string;
  readonly enabled: boolean;
  /** Entries older than this are ignored so a model alias update eventually takes effect. */
  readonly ttlMs: number;

  constructor(enabled: boolean, ttlMs = 7 * 24 * 60 * 60 * 1000, dir = cacheDir()) {
    this.enabled = enabled;
    this.ttlMs = ttlMs;
    this.dir = dir;
  }

  private pathFor(key: string): string {
    // Shard by the first two hex characters to keep directory sizes sane.
    return join(this.dir, key.slice(0, 2), `${key.slice(2)}.json`);
  }

  get<T>(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const path = this.pathFor(key);
    if (!existsSync(path)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry<T>;
      if (!entry || typeof entry.at !== "number") return undefined;
      if (Date.now() - entry.at > this.ttlMs) return undefined;
      return entry.value;
    } catch {
      // A truncated or corrupt entry is a miss, never a failure.
      return undefined;
    }
  }

  set<T>(key: string, value: T): void {
    if (!this.enabled) return;
    const path = this.pathFor(key);
    try {
      mkdirSync(join(this.dir, key.slice(0, 2)), { recursive: true });
      const entry: CacheEntry<T> = { at: Date.now(), value };
      writeFileSync(path, JSON.stringify(entry));
    } catch {
      // A cache write failure must never fail the command.
    }
  }
}

export function cacheStats(dir = cacheDir()): { entries: number; bytes: number; dir: string } {
  let entries = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { entries, bytes, dir };
  for (const shard of readdirSync(dir)) {
    const shardPath = join(dir, shard);
    let children: string[];
    try {
      if (!statSync(shardPath).isDirectory()) continue;
      children = readdirSync(shardPath);
    } catch {
      continue;
    }
    for (const file of children) {
      try {
        bytes += statSync(join(shardPath, file)).size;
        entries += 1;
      } catch {
        /* raced with a concurrent clear */
      }
    }
  }
  return { entries, bytes, dir };
}

export function clearCache(dir = cacheDir()): number {
  const { entries } = cacheStats(dir);
  rmSync(dir, { recursive: true, force: true });
  return entries;
}
