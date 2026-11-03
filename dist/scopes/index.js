import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { isInside } from "../config.js";
export const GENERAL = "general";
export function slug(text) {
    return (text
        .toLowerCase()
        .replace(/\.git$/, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || GENERAL);
}
export function readScopes(path) {
    if (!existsSync(path))
        return { scopes: {}, rules: [] };
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { scopes: data.scopes ?? {}, rules: data.rules ?? [] };
}
export function writeScopes(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}
function git(cwd, args) {
    try {
        return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    }
    catch {
        return undefined;
    }
}
export function normalizeRemote(url) {
    return url
        .trim()
        .replace(/^git@([^:]+):/, "https://$1/")
        .replace(/^ssh:\/\/git@/, "https://")
        .replace(/\.git$/, "")
        .toLowerCase();
}
/**
 * Pick the scope for a working directory, following the order in docs/DESIGN.md section 3.
 * Folders inside `generalPaths` (app scratch folders and the like) go to the general scope.
 */
export function detectScope(cwd, file, generalPaths = []) {
    if (!cwd || !existsSync(cwd))
        return { scope: GENERAL };
    const dir = resolve(cwd);
    const remoteRaw = git(dir, ["remote", "get-url", "origin"]);
    const remote = remoteRaw ? normalizeRemote(remoteRaw) : undefined;
    const gitRoot = git(dir, ["rev-parse", "--show-toplevel"]);
    if (remote) {
        const rule = file.rules.find((r) => r.kind === "remote" && r.match === remote);
        if (rule)
            return { scope: rule.scope, remote, gitRoot };
    }
    const pathRule = file.rules
        .filter((r) => r.kind === "path" && isInside(dir, [r.match]))
        .sort((a, b) => b.match.length - a.match.length)[0];
    if (pathRule)
        return { scope: pathRule.scope, remote, gitRoot };
    if (isInside(dir, generalPaths))
        return { scope: GENERAL };
    if (remote)
        return { scope: slug(remote.split("/").pop() ?? GENERAL), remote, gitRoot };
    if (gitRoot)
        return { scope: slug(basename(gitRoot)), gitRoot };
    if (dir === homedir() || dir === "/")
        return { scope: GENERAL };
    return { scope: slug(basename(dir)) };
}
/** Whether a session in `from` may read notes in `target`. */
export function canRead(from, target, file) {
    if (from === target || target === GENERAL)
        return true;
    if (file.scopes[target]?.isolated)
        return false;
    return !file.scopes[from]?.isolated;
}
export function isIsolated(scope, file) {
    return Boolean(file.scopes[scope]?.isolated);
}
