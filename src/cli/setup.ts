import spawn from "cross-spawn";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_FILE, DEFAULT_CONFIG, INIT_KEYS, loadConfig } from "../config.js";
import {
  CODEX_TIMEOUTS,
  CODEX_TRUST_NOTE,
  codexHooksPath,
  codexMcpArgs,
  hookCommand,
  mergeHooks,
  readSettings,
  removeHooks,
  serverCommand,
  settingsPath,
  writeSettings,
} from "./install.js";
import { MODEL, modelInstalled, pullModel } from "../embed/index.js";
import { findOnPath, installNightly } from "./nightly.js";
import { LEGACY_NAME, NAME } from "../names.js";

/**
 * One-command install and uninstall for Claude Code and Codex: the atlas folder, the MCP server
 * registration, the capture hooks and, if wanted, the nightly tidy.
 */

export interface SetupDeps {
  ask: (question: string, fallback: boolean) => Promise<boolean>;
  exec: (command: string, args: string[]) => { ok: boolean; out: string };
  log: (line: string) => void;
  home: string;
  platform: NodeJS.Platform;
  claude?: string;
  /** The codex executable, or "" when Codex is not on PATH. */
  codex?: string;
  /** Fetch the search model; returns false when it is already there. */
  pullModel?: () => Promise<boolean>;
}

export function defaultDeps(): SetupDeps {
  return {
    ask: async (question, fallback) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
      rl.close();
      return answer ? answer === "y" || answer === "yes" : fallback;
    },
    // cross-spawn, so a claude.cmd shim on Windows runs too.
    exec: (command, args) => {
      const r = spawn.sync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (r.error) return { ok: false, out: r.error.message };
      return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, out: r.stderr || `exited with code ${r.status}` };
    },
    log: (line) => console.log(line),
    home: homedir(),
    platform: process.platform,
    pullModel: async () => {
      if (modelInstalled()) return false;
      await pullModel();
      return true;
    },
  };
}

/** Create the atlas folder and its config if they are missing, then set the given keys. */
export function initAtlas(dir: string, set: Record<string, unknown> = {}) {
  mkdirSync(join(dir, ".atlas"), { recursive: true });
  const file = join(dir, CONFIG_FILE);
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : Object.fromEntries(INIT_KEYS.map((k) => [k, DEFAULT_CONFIG[k]]));
  Object.assign(config, set);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

export interface SetupOptions {
  dir: string;
  script: string;
  yes: boolean;
  isolate?: boolean;
  nightly?: boolean;
}

/** Codex is set up when its binary is on PATH or its folder exists (the desktop app keeps the binary inside the app). */
function findCodex(deps: SetupDeps): { bin?: string; hooks?: string } {
  const bin = deps.codex ?? findOnPath("codex");
  const hooks = bin || existsSync(join(deps.home, ".codex")) ? codexHooksPath(deps.home) : undefined;
  return { bin: bin || undefined, hooks };
}

export async function setup(opts: SetupOptions, deps: SetupDeps = defaultDeps()): Promise<boolean> {
  const { log } = deps;
  const claude = deps.claude ?? findOnPath("claude");
  const codex = findCodex(deps);
  const settings = settingsPath(deps.home);
  log(`Varve setup\n`);
  log(`This will:`);
  log(`  1. Create the atlas at ${opts.dir} (existing notes are kept).`);
  if (claude) {
    log(`  2. Register the MCP server with Claude Code for your user (claude mcp add --scope user).`);
    log(`  3. Add the capture hooks to ${settings} (a backup goes to settings.json.bak).`);
  } else if (!codex.hooks) {
    log(`  Claude Code was not found on PATH, so only the atlas is created. Steps for other clients are printed at the end.`);
  }
  if (codex.hooks) log(`  ${claude ? 4 : 2}. Add the capture hooks to ${codex.hooks}${codex.bin ? " and register the MCP server with Codex" : ""}.`);
  log(`  Nothing is sent anywhere. The atlas is plain Markdown on this machine.\n`);
  if (!opts.yes && !(await deps.ask("Continue?", true))) {
    log("Nothing changed.");
    return false;
  }

  const isolate =
    opts.isolate ??
    (opts.yes
      ? true
      : await deps.ask(
          "\nDo you work for more than one client on this machine? If so, each project's memory is kept isolated: no project's brief or search shows another's work. Isolate projects?",
          true,
        ));
  initAtlas(opts.dir, existsSync(join(opts.dir, CONFIG_FILE)) && opts.isolate === undefined && opts.yes ? {} : { isolateNewScopes: isolate });
  log(`\nAtlas ready at ${opts.dir}${isolate ? " (new projects start isolated)" : ""}.`);

  if (codex.hooks) {
    writeSettings(codex.hooks, mergeHooks(readSettings(codex.hooks), hookCommand(opts.dir, opts.script, deps.platform), { client: "codex", timeouts: CODEX_TIMEOUTS }));
    log(`Codex capture hooks installed in ${codex.hooks}. ${CODEX_TRUST_NOTE}`);
    if (codex.bin) {
      for (const name of [NAME, LEGACY_NAME]) deps.exec(codex.bin, ["mcp", "remove", name]);
      const r = deps.exec(codex.bin, codexMcpArgs(opts.dir, opts.script));
      log(r.ok ? "MCP server registered with Codex." : `Could not register the MCP server with Codex: ${r.out.trim()}`);
    } else {
      log(`Codex is not on PATH. Register the MCP server with: codex ${codexMcpArgs(opts.dir, opts.script).map((a) => JSON.stringify(a)).join(" ")}`);
    }
  }

  if (!claude) {
    const [command, ...args] = serverCommand(opts.script);
    log(`\nAdd the server to your agent: command ${JSON.stringify(command)}, args ${JSON.stringify(args)}, env VARVE_DIR=${JSON.stringify(opts.dir)}.`);
    await offerModel(opts, deps);
    return true;
  }

  // A registration under the old name would start a second server; replace it.
  for (const name of [NAME, LEGACY_NAME]) deps.exec(claude, ["mcp", "remove", name, "--scope", "user"]);
  const added = deps.exec(claude, ["mcp", "add", NAME, "--scope", "user", "-e", `VARVE_DIR=${opts.dir}`, "--", ...serverCommand(opts.script)]);
  log(added.ok ? "MCP server registered with Claude Code." : `Could not register the MCP server: ${added.out.trim()}`);

  writeSettings(settings, mergeHooks(readSettings(settings), hookCommand(opts.dir, opts.script, deps.platform)));
  log("Capture hooks installed: every Claude Code session is now recorded after each turn.");

  const nightly =
    opts.nightly ??
    (opts.yes
      ? false
      : await deps.ask(
          `\nWrite the day, week and month summaries every night at 04:30, using your Claude Code sign-in? If the computer is off then, it runs at the next login instead. Each night stops at $${DEFAULT_CONFIG.tidy.maxUsd.toFixed(2)}. Without this, your agent writes them when you ask it to tidy the atlas.`,
          false,
        ));
  if (nightly) {
    await installNightly({ atlasDir: opts.dir, script: opts.script, config: loadConfig(opts.dir), yes: true, platform: deps.platform, home: deps.home, log });
  }

  await offerModel(opts, deps);

  log(`\nDone. Open a new Claude Code session in any project: the agent gets a brief of past work there.`);
  log(`Check the install any time with: varve doctor`);
  log(`Remove it with: varve uninstall (your notes stay in ${opts.dir})`);
  return true;
}

/** Search by meaning needs a 30 MB model from Hugging Face. Asked, never fetched with --yes. */
async function offerModel(opts: SetupOptions, deps: SetupDeps) {
  const later = "Search is keyword only for now. To match by meaning too, run: varve models pull";
  if (opts.yes || !deps.pullModel) {
    deps.log(`\n${later}`);
    return;
  }
  const want = await deps.ask(
    `\nDownload the search model (${MODEL.name}, about 30 MB, ${MODEL.licence} licence, from Hugging Face)? Search then finds notes by meaning, not only by keyword. It runs on this machine; nothing is sent.`,
    true,
  );
  if (!want) {
    deps.log(later);
    return;
  }
  try {
    deps.log((await deps.pullModel()) ? "Search model installed." : "Search model already installed.");
  } catch (err) {
    deps.log(`Could not download the search model: ${err instanceof Error ? err.message : String(err)}. ${later}`);
  }
}

export async function uninstall(opts: { dir: string; script: string; yes: boolean }, deps: SetupDeps = defaultDeps()): Promise<boolean> {
  const { log } = deps;
  const claude = deps.claude ?? findOnPath("claude");
  const codex = findCodex(deps);
  const settings = settingsPath(deps.home);
  log("This removes the Varve hooks from Claude Code and Codex, the MCP server registrations and the nightly run.");
  log(`Your notes in ${opts.dir} are not touched.\n`);
  if (!opts.yes && !(await deps.ask("Uninstall?", false))) {
    log("Nothing changed.");
    return false;
  }
  if (existsSync(settings)) {
    writeSettings(settings, removeHooks(readSettings(settings)));
    log(`Hooks removed from ${settings} (backup in settings.json.bak).`);
  }
  if (claude) {
    const removed = [NAME, LEGACY_NAME].map((name) => deps.exec(claude, ["mcp", "remove", name, "--scope", "user"]).ok);
    log(removed.some(Boolean) ? "MCP server registration removed." : "No MCP server registration to remove.");
  }
  if (codex.hooks && existsSync(codex.hooks)) {
    writeSettings(codex.hooks, removeHooks(readSettings(codex.hooks)));
    log(`Hooks removed from ${codex.hooks} (backup in hooks.json.bak).`);
  }
  if (codex.bin) {
    const removed = [NAME, LEGACY_NAME].map((name) => deps.exec(codex.bin!, ["mcp", "remove", name]).ok);
    log(removed.some(Boolean) ? "Codex MCP server registration removed." : "No Codex MCP server registration to remove.");
  }
  await installNightly({ atlasDir: opts.dir, script: opts.script, config: loadConfig(opts.dir), yes: true, remove: true, platform: deps.platform, home: deps.home, log });
  log(`\nUninstalled. To delete your notes too, delete ${opts.dir}.`);
  return true;
}
