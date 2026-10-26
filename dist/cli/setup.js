import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_FILE, DEFAULT_CONFIG, INIT_KEYS, loadConfig } from "../config.js";
import { hookCommand, mergeHooks, readSettings, removeHooks, serverCommand, settingsPath, writeSettings } from "./install.js";
import { findOnPath, installNightly } from "./nightly.js";
export function defaultDeps() {
    return {
        ask: async (question, fallback) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
            rl.close();
            return answer ? answer === "y" || answer === "yes" : fallback;
        },
        exec: (command, args) => {
            try {
                return { ok: true, out: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
            }
            catch (e) {
                const err = e;
                return { ok: false, out: err.stderr || err.message };
            }
        },
        log: (line) => console.log(line),
        home: homedir(),
        platform: process.platform,
    };
}
/** Create the atlas folder and its config if they are missing, then set the given keys. */
export function initAtlas(dir, set = {}) {
    mkdirSync(join(dir, ".atlas"), { recursive: true });
    const file = join(dir, CONFIG_FILE);
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : Object.fromEntries(INIT_KEYS.map((k) => [k, DEFAULT_CONFIG[k]]));
    Object.assign(config, set);
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
export async function setup(opts, deps = defaultDeps()) {
    const { log } = deps;
    const claude = deps.claude ?? findOnPath("claude");
    const settings = settingsPath(deps.home);
    log(`Temporal Atlas setup\n`);
    log(`This will:`);
    log(`  1. Create the atlas at ${opts.dir} (existing notes are kept).`);
    if (claude) {
        log(`  2. Register the MCP server with Claude Code for your user (claude mcp add --scope user).`);
        log(`  3. Add the capture hooks to ${settings} (a backup goes to settings.json.bak).`);
    }
    else {
        log(`  Claude Code was not found on PATH, so only the atlas is created. Steps for other clients are printed at the end.`);
    }
    log(`  Nothing is sent anywhere. The atlas is plain Markdown on this machine.\n`);
    if (!opts.yes && !(await deps.ask("Continue?", true))) {
        log("Nothing changed.");
        return false;
    }
    const isolate = opts.isolate ??
        (opts.yes
            ? true
            : await deps.ask("\nDo you work for more than one client on this machine? If so, each project's memory is kept isolated: no project's brief or search shows another's work. Isolate projects?", true));
    initAtlas(opts.dir, existsSync(join(opts.dir, CONFIG_FILE)) && opts.isolate === undefined && opts.yes ? {} : { isolateNewScopes: isolate });
    log(`\nAtlas ready at ${opts.dir}${isolate ? " (new projects start isolated)" : ""}.`);
    if (!claude) {
        const [command, ...args] = serverCommand(opts.script);
        log(`\nAdd the server to your agent: command ${JSON.stringify(command)}, args ${JSON.stringify(args)}, env TEMPORAL_ATLAS_DIR=${JSON.stringify(opts.dir)}.`);
        return true;
    }
    deps.exec(claude, ["mcp", "remove", "temporal-atlas", "--scope", "user"]);
    const added = deps.exec(claude, ["mcp", "add", "temporal-atlas", "--scope", "user", "-e", `TEMPORAL_ATLAS_DIR=${opts.dir}`, "--", ...serverCommand(opts.script)]);
    log(added.ok ? "MCP server registered with Claude Code." : `Could not register the MCP server: ${added.out.trim()}`);
    writeSettings(settings, mergeHooks(readSettings(settings), hookCommand(opts.dir, opts.script, deps.platform)));
    log("Capture hooks installed: every Claude Code session is now recorded after each turn.");
    const nightly = opts.nightly ??
        (opts.yes
            ? false
            : await deps.ask(`\nWrite the day, week and month summaries every night at 04:30, using your Claude Code sign-in? If the computer is off then, it runs at the next login instead. Each night stops at $${DEFAULT_CONFIG.tidy.maxUsd.toFixed(2)}. Without this, your agent writes them when you ask it to tidy the atlas.`, false));
    if (nightly) {
        await installNightly({ atlasDir: opts.dir, script: opts.script, config: loadConfig(opts.dir), yes: true, platform: deps.platform, home: deps.home, log });
    }
    log(`\nDone. Open a new Claude Code session in any project: the agent gets a brief of past work there.`);
    log(`Check the install any time with: temporal-atlas doctor`);
    log(`Remove it with: temporal-atlas uninstall (your notes stay in ${opts.dir})`);
    return true;
}
export async function uninstall(opts, deps = defaultDeps()) {
    const { log } = deps;
    const claude = deps.claude ?? findOnPath("claude");
    const settings = settingsPath(deps.home);
    log("This removes the Temporal Atlas hooks from Claude Code, the MCP server registration and the nightly run.");
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
        const r = deps.exec(claude, ["mcp", "remove", "temporal-atlas", "--scope", "user"]);
        log(r.ok ? "MCP server registration removed." : "No MCP server registration to remove.");
    }
    await installNightly({ atlasDir: opts.dir, script: opts.script, config: loadConfig(opts.dir), yes: true, remove: true, platform: deps.platform, home: deps.home, log });
    log(`\nUninstalled. To delete your notes too, delete ${opts.dir}.`);
    return true;
}
