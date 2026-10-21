import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type AtlasConfig, CONFIG_FILE } from "../config.js";

export const LABEL = "io.temporal-atlas.tidy";

/** Find an executable on PATH, as `which` would. */
export function findOnPath(command: string, path = process.env.PATH ?? ""): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  for (const dir of path.split(delimiter)) {
    const full = join(dir, command);
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      // not here
    }
  }
  return undefined;
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The tidy command the schedule runs: this exact script when installed locally, npx otherwise. */
export function tidyProgram(script: string, node = process.execPath): string[] {
  if (script.includes("/_npx/")) return [findOnPath("npx") ?? "npx", "-y", "temporal-atlas", "tidy", "--yes"];
  return [node, script, "tidy", "--yes"];
}

export function launchdPlist(opts: { program: string[]; atlasDir: string; at: string; path: string; log: string }): string {
  const [hour, minute] = opts.at.split(":").map(Number);
  const args = opts.program.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TEMPORAL_ATLAS_DIR</key>
    <string>${xml(opts.atlasDir)}</string>
    <key>PATH</key>
    <string>${xml(opts.path)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(opts.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.log)}</string>
</dict>
</plist>
`;
}

export function cronLine(opts: { program: string[]; atlasDir: string; at: string; log: string }): string {
  const [hour, minute] = opts.at.split(":").map(Number);
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `${minute} ${hour} * * * TEMPORAL_ATLAS_DIR=${quote(opts.atlasDir)} ${opts.program.map(quote).join(" ")} >> ${quote(opts.log)} 2>&1`;
}

/** Set `rollups` in atlas.config.json, keeping every other key. */
export function setRollupMode(atlasDir: string, mode: AtlasConfig["rollups"]) {
  const file = join(atlasDir, CONFIG_FILE);
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  config.rollups = mode;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

export interface NightlyOptions {
  atlasDir: string;
  script: string;
  config: AtlasConfig;
  at?: string;
  yes: boolean;
  remove?: boolean;
  platform?: NodeJS.Platform;
  home?: string;
}

/** Schedule `temporal-atlas tidy --yes` once a night, after the day boundary. */
export async function installNightly(opts: NightlyOptions): Promise<boolean> {
  const at = opts.at ?? opts.config.tidy.at;
  if (!/^\d{1,2}:\d{2}$/.test(at)) throw new Error(`--at takes a local time like 04:30, not "${at}".`);
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const program = tidyProgram(opts.script);
  const log = join(opts.atlasDir, ".atlas", "tidy.out");

  if (platform !== "darwin") {
    if (opts.remove) {
      console.log("Remove the temporal-atlas line from your crontab with `crontab -e`, and set \"rollups\": \"agent\" in atlas.config.json.");
      return false;
    }
    console.log("Add this line with `crontab -e`:\n");
    console.log(cronLine({ program, atlasDir: opts.atlasDir, at, log }));
    console.log(`\nThen set "rollups": "nightly" in ${join(opts.atlasDir, CONFIG_FILE)} so agents leave the rollups to the nightly run.`);
    return false;
  }

  const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  if (opts.remove) {
    if (!existsSync(plist)) {
      console.log("No nightly run is installed.");
      return false;
    }
    if (!opts.yes && !(await confirm(`Remove ${plist} and set "rollups" back to "agent"? [y/N] `))) return false;
    try {
      execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
    } catch {
      // not loaded
    }
    rmSync(plist, { force: true });
    setRollupMode(opts.atlasDir, "agent");
    console.log("Removed. Agents will do rollups again.");
    return true;
  }

  const claude = findOnPath(opts.config.tidy.command);
  if (!claude) throw new Error(`Cannot find "${opts.config.tidy.command}" on PATH. Install Claude Code, or set tidy.command in atlas.config.json.`);
  const path = [...new Set([dirname(claude), dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"])].join(":");
  const text = launchdPlist({ program, atlasDir: opts.atlasDir, at, path, log });
  const { model, maxTokens, maxUsd } = opts.config.tidy;

  console.log(`Every night at ${at}, run:\n  ${program.join(" ")}\n`);
  console.log(`Each run writes pending rollups with ${claude} (model ${model}) and stops at ${maxTokens} tokens or $${maxUsd.toFixed(2)}, whichever comes first.`);
  console.log(`Change those limits under "tidy" in ${join(opts.atlasDir, CONFIG_FILE)}.\n`);
  console.log(`Files written:\n  ${plist} (launchd job)\n  ${join(opts.atlasDir, CONFIG_FILE)} ("rollups": "nightly", so agents stop doing rollups)`);
  console.log(`Output goes to ${log}; every rollup is logged with its cost in ${join(opts.atlasDir, ".atlas", "tidy.log")}.`);
  if (!opts.yes && !(await confirm("\nInstall the nightly run? [y/N] "))) {
    console.log("Nothing written.");
    return false;
  }
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(plist, text);
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  } catch {
    // not loaded yet
  }
  execFileSync("launchctl", ["bootstrap", domain, plist]);
  setRollupMode(opts.atlasDir, "nightly");
  console.log(`\nInstalled. If the Mac is asleep at ${at}, launchd runs it when it wakes. Remove it with: temporal-atlas install nightly --remove`);
  return true;
}
