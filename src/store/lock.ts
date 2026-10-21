import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCK_TTL_MS = 30 * 60 * 1000;

interface LockRecord {
  owner: string;
  at: string;
}

function lockPath(dir: string, key: string) {
  return join(dir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
}

/** The live holder of a rollup lock, if any. Locks older than 30 minutes are ignored. */
export function lockHolder(dir: string, key: string, now: Date): string | undefined {
  const path = lockPath(dir, key);
  if (!existsSync(path)) return undefined;
  const rec = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
  if (now.getTime() - new Date(rec.at).getTime() > LOCK_TTL_MS) return undefined;
  return rec.owner;
}

export function takeLock(dir: string, key: string, owner: string, now: Date): boolean {
  const holder = lockHolder(dir, key, now);
  if (holder && holder !== owner) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath(dir, key), JSON.stringify({ owner, at: now.toISOString() }));
  return true;
}

export function releaseLock(dir: string, key: string) {
  rmSync(lockPath(dir, key), { force: true });
}

/** Run `fn` while holding a short-lived cross-process mutex on `path`. */
export function withMutex<T>(path: string, fn: () => T): T {
  const dir = `${path}.mutex`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch {
      if (Date.now() > deadline) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
