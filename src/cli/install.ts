import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

const EVENTS: [string, string][] = [
  ["SessionStart", "session-start"],
  ["SessionEnd", "session-end"],
];

const isAtlasHook = (e: HookEntry) => e.hooks.some((h) => /temporal-atlas(\.js)?["']?\s+hook\b|cli\/main\.js["']?\s+hook\b/.test(h.command));

/** Add the atlas hooks to Claude Code settings, replacing any earlier atlas hooks and keeping everything else. */
export function mergeHooks(settings: Settings, command: string): Settings {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, arg] of EVENTS) {
    const kept = (hooks[event] ?? []).filter((e) => !isAtlasHook(e));
    hooks[event] = [...kept, { hooks: [{ type: "command", command: `${command} ${arg}`, timeout: 30 }] }];
  }
  return { ...settings, hooks };
}

/** The command the hooks should run: this exact script when installed locally, npx otherwise. */
export function hookCommand(atlasDir: string, script: string): string {
  const env = `TEMPORAL_ATLAS_DIR=${JSON.stringify(atlasDir)}`;
  if (script.includes("/_npx/")) return `${env} npx -y temporal-atlas hook`;
  return `${env} node ${JSON.stringify(script)} hook`;
}

export async function installClaudeCode(opts: { atlasDir: string; script: string; yes: boolean; settingsPath?: string }) {
  const path = opts.settingsPath ?? join(homedir(), ".claude", "settings.json");
  const before: Settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const after = mergeHooks(before, hookCommand(opts.atlasDir, opts.script));
  const show = (s: Settings) => JSON.stringify({ SessionStart: s.hooks?.SessionStart, SessionEnd: s.hooks?.SessionEnd }, null, 2);

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
  if (existsSync(path)) writeFileSync(`${path}.bak`, readFileSync(path));
  writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
  console.log(`\nWritten. A backup of the previous file is at ${path}.bak`);
  console.log("\nIf the MCP server is not added yet, run:");
  console.log(`  claude mcp add temporal-atlas --scope user -e TEMPORAL_ATLAS_DIR=${JSON.stringify(opts.atlasDir)} -- npx -y temporal-atlas`);
  return true;
}
