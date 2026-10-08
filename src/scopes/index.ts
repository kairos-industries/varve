import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export const GENERAL = "general";

export interface ScopeRule {
  /** A git remote URL (normalized) or an absolute directory path. */
  match: string;
  kind: "remote" | "path";
  scope: string;
}

export interface ScopeInfo {
  isolated?: boolean;
}

export interface ScopesFile {
  scopes: Record<string, ScopeInfo>;
  rules: ScopeRule[];
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/\.git$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || GENERAL
  );
}

export function readScopes(path: string): ScopesFile {
  if (!existsSync(path)) return { scopes: {}, rules: [] };
  const data = JSON.parse(readFileSync(path, "utf8")) as Partial<ScopesFile>;
  return { scopes: data.scopes ?? {}, rules: data.rules ?? [] };
}

export function writeScopes(path: string, data: ScopesFile) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "")
    .toLowerCase();
}

export interface Detection {
  scope: string;
  remote?: string;
  gitRoot?: string;
}

/** Pick the scope for a working directory, following the order in DESIGN.md section 3. */
export function detectScope(cwd: string | undefined, file: ScopesFile): Detection {
  if (!cwd || !existsSync(cwd)) return { scope: GENERAL };
  const dir = resolve(cwd);
  const remoteRaw = git(dir, ["remote", "get-url", "origin"]);
  const remote = remoteRaw ? normalizeRemote(remoteRaw) : undefined;
  const gitRoot = git(dir, ["rev-parse", "--show-toplevel"]);

  if (remote) {
    const rule = file.rules.find((r) => r.kind === "remote" && r.match === remote);
    if (rule) return { scope: rule.scope, remote, gitRoot };
  }
  const pathRule = file.rules
    .filter((r) => r.kind === "path" && (dir === r.match || dir.startsWith(`${r.match}/`)))
    .sort((a, b) => b.match.length - a.match.length)[0];
  if (pathRule) return { scope: pathRule.scope, remote, gitRoot };

  if (remote) return { scope: slug(remote.split("/").pop() ?? GENERAL), remote, gitRoot };
  if (gitRoot) return { scope: slug(basename(gitRoot)), gitRoot };
  if (dir === homedir() || dir === "/") return { scope: GENERAL };
  return { scope: slug(basename(dir)) };
}

/** Whether a session in `from` may read notes in `target`. */
export function canRead(from: string, target: string, file: ScopesFile): boolean {
  if (from === target || target === GENERAL) return true;
  if (file.scopes[target]?.isolated) return false;
  return !file.scopes[from]?.isolated;
}

export function isIsolated(scope: string, file: ScopesFile): boolean {
  return Boolean(file.scopes[scope]?.isolated);
}
