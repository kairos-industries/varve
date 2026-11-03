import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
/** Claude Code hook events and the `temporal-atlas hook` argument each one runs. */
export const EVENTS = [
    ["SessionStart", "session-start"],
    ["Stop", "stop"],
    ["SessionEnd", "session-end"],
];
/** Matches both `node ".../cli/main.js" --dir "..." hook` and the older `TEMPORAL_ATLAS_DIR=... node ".../cli/main.js" hook`. */
export const ATLAS_HOOK = /(temporal-atlas|cli[\\/]main\.js)\b.*\shook\b/;
const isAtlasHook = (e) => e.hooks.some((h) => ATLAS_HOOK.test(h.command));
/** Codex caps SessionEnd hooks at 3 seconds. */
export const CODEX_TIMEOUTS = { SessionEnd: 3 };
/**
 * Add the atlas hooks to Claude Code settings or Codex hooks.json (the same shape), replacing
 * any earlier atlas hooks and keeping everything else.
 */
export function mergeHooks(settings, command, opts = {}) {
    const hooks = { ...(settings.hooks ?? {}) };
    const suffix = opts.client && opts.client !== "claude-code" ? ` --client ${opts.client}` : "";
    for (const [event, arg] of EVENTS) {
        const kept = (hooks[event] ?? []).filter((e) => !isAtlasHook(e));
        hooks[event] = [...kept, { hooks: [{ type: "command", command: `${command} ${arg}${suffix}`, timeout: opts.timeouts?.[event] ?? 30 }] }];
    }
    return { ...settings, hooks };
}
/** Remove every atlas hook, keeping everything else. Events left with no hooks are dropped. */
export function removeHooks(settings) {
    const hooks = {};
    for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
        const kept = entries.filter((e) => !isAtlasHook(e));
        if (kept.length)
            hooks[event] = kept;
    }
    const out = { ...settings, hooks };
    if (!Object.keys(hooks).length)
        delete out.hooks;
    return out;
}
export function settingsPath(home = homedir()) {
    return join(home, ".claude", "settings.json");
}
export function codexHooksPath(home = homedir()) {
    return join(home, ".codex", "hooks.json");
}
/** How Codex should start the server, as `codex mcp add` arguments. */
export function codexMcpArgs(atlasDir, script) {
    return ["mcp", "add", "temporal-atlas", "--env", `TEMPORAL_ATLAS_DIR=${atlasDir}`, "--", ...serverCommand(script)];
}
export const CODEX_TRUST_NOTE = "Codex runs new hooks only after you trust them: open Codex and run /hooks once.";
/** Write Claude Code settings, keeping the previous file as settings.json.bak. */
export function writeSettings(path, settings) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path))
        writeFileSync(`${path}.bak`, readFileSync(path));
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}
export function readSettings(path) {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}
/** A path as a double-quoted shell word. On Windows, forward slashes, so bash, cmd and PowerShell all read it the same. */
function quotePath(path, platform) {
    return JSON.stringify(platform === "win32" ? path.replace(/\\/g, "/") : path);
}
/** The command the hooks run. The atlas folder goes in --dir, not an environment prefix, which only POSIX shells understand. */
export function hookCommand(atlasDir, script, platform = process.platform) {
    return `node ${quotePath(script, platform)} --dir ${quotePath(atlasDir, platform)} hook`;
}
/** How an MCP client should start the server: this exact build with this Node. */
export function serverCommand(script, node = process.execPath) {
    return [node, script];
}
export async function installCodex(opts) {
    const path = opts.hooksPath ?? codexHooksPath();
    const after = mergeHooks(readSettings(path), hookCommand(opts.atlasDir, opts.script), { client: "codex", timeouts: CODEX_TIMEOUTS });
    console.log(`Codex hooks: ${path}\n`);
    console.log(JSON.stringify(Object.fromEntries(EVENTS.map(([e]) => [e, after.hooks?.[e]])), null, 2));
    console.log("\nEverything else in the file stays as it is.");
    if (!opts.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question("\nWrite this change? [y/N] ")).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") {
            console.log("Nothing written.");
            return false;
        }
    }
    writeSettings(path, after);
    console.log(`\nWritten. A backup of the previous file is at ${path}.bak`);
    console.log(CODEX_TRUST_NOTE);
    console.log("\nIf the MCP server is not added yet, run:");
    console.log(`  codex ${codexMcpArgs(opts.atlasDir, opts.script).map((a) => JSON.stringify(a)).join(" ")}`);
    return true;
}
export async function installClaudeCode(opts) {
    const path = opts.settingsPath ?? join(homedir(), ".claude", "settings.json");
    const before = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    const after = mergeHooks(before, hookCommand(opts.atlasDir, opts.script));
    const show = (s) => JSON.stringify(Object.fromEntries(EVENTS.map(([e]) => [e, s.hooks?.[e]])), null, 2);
    console.log(`Claude Code settings: ${path}\n`);
    console.log("Hooks after the change:\n");
    console.log(show(after));
    console.log("\nEverything else in the file stays as it is.");
    if (!opts.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question("\nWrite this change? [y/N] ")).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") {
            console.log("Nothing written.");
            return false;
        }
    }
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path))
        writeFileSync(`${path}.bak`, readFileSync(path));
    writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
    console.log(`\nWritten. A backup of the previous file is at ${path}.bak`);
    console.log("\nIf the MCP server is not added yet, run:");
    console.log(`  claude mcp add temporal-atlas --scope user -e TEMPORAL_ATLAS_DIR=${JSON.stringify(opts.atlasDir)} -- ${serverCommand(opts.script).map((a) => JSON.stringify(a)).join(" ")}`);
    return true;
}
