import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type AtlasConfig, CONFIG_FILE } from "../config.js";
import { AtlasPaths } from "../store/paths.js";

export const LABEL = "io.temporal-atlas.tidy";

/** Find an executable on PATH, as `which` would. On Windows, also tries the PATHEXT extensions (claude.exe, claude.cmd). */
export function findOnPath(command: string, path = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform): string | undefined {
  const exts = platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
  const dirs = isAbsolute(command) ? [""] : path.split(delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = dir ? join(dir, command + ext) : command + ext;
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The tidy command the schedule runs. `--scheduled` makes it run at most once per atlas day. */
export function tidyProgram(script: string, node = process.execPath): string[] {
  return [node, script, "tidy", "--scheduled"];
}

/** What the schedule has done, kept in .atlas/nightly.json. */
export interface NightlyState {
  installedAt?: string;
  /** When the last scheduled run that reached the model, or had nothing to do, finished. */
  lastRunAt?: string;
  /** The atlas day of that run. A scheduled run skips a day it has already run in. */
  lastRunDay?: string;
  lastResult?: string;
}

export function readNightlyState(atlasDir: string): NightlyState {
  const file = new AtlasPaths(atlasDir).nightlyFile;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function writeNightlyState(atlasDir: string, patch: NightlyState) {
  const file = new AtlasPaths(atlasDir).nightlyFile;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...readNightlyState(atlasDir), ...patch }, null, 2)}\n`);
}

/**
 * The launchd job runs at the set time, at login and every hour after. A Mac that was shut down at
 * the set time catches up at the next login, and `tidy --scheduled` turns the extra runs into no-ops.
 */
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
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>${xml(opts.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.log)}</string>
</dict>
</plist>
`;
}

/** Hourly, so a machine that was off at the set time catches up; `tidy --scheduled` runs once a day. */
export function cronLine(opts: { program: string[]; atlasDir: string; at: string; log: string }): string {
  const minute = Number(opts.at.split(":")[1]);
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `${minute} * * * * TEMPORAL_ATLAS_DIR=${quote(opts.atlasDir)} ${opts.program.map(quote).join(" ")} >> ${quote(opts.log)} 2>&1`;
}

/** A Task Scheduler entry for Windows, with the atlas folder passed as --dir because tasks cannot set variables. */
export function schtasksCommand(opts: { program: string[]; atlasDir: string; at: string }): string {
  const [node, script, ...rest] = opts.program;
  const run = [node, script, "--dir", opts.atlasDir].map((s) => `\\"${s}\\"`).concat(rest).join(" ");
  return `schtasks /Create /TN "temporal-atlas-tidy" /SC HOURLY /ST ${opts.at.padStart(5, "0")} /TR "${run}" /F`;
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
  now?: Date;
  log?: (line: string) => void;
}

/** Schedule `temporal-atlas tidy --scheduled` once a night, after the day boundary, catching up at login. */
export async function installNightly(opts: NightlyOptions): Promise<boolean> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const at = opts.at ?? opts.config.tidy.at;
  if (!/^\d{1,2}:\d{2}$/.test(at)) throw new Error(`--at takes a local time like 04:30, not "${at}".`);
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const program = tidyProgram(opts.script);
  const logFile = join(opts.atlasDir, ".atlas", "tidy.out");

  if (platform === "win32") {
    if (opts.remove) {
      log('Remove the task with: schtasks /Delete /TN "temporal-atlas-tidy" /F\nThen set "rollups": "agent" in atlas.config.json.');
      return false;
    }
    log("Create the scheduled task with this command (it runs hourly from the set time and writes rollups once a day):\n");
    log(schtasksCommand({ program, atlasDir: opts.atlasDir, at }));
    log(`\nThen set "rollups": "nightly" in ${join(opts.atlasDir, CONFIG_FILE)} so agents leave the rollups to the nightly run.`);
    writeNightlyState(opts.atlasDir, { installedAt: (opts.now ?? new Date()).toISOString() });
    return false;
  }

  if (platform !== "darwin") {
    if (opts.remove) {
      log("Remove the temporal-atlas line from your crontab with `crontab -e`, and set \"rollups\": \"agent\" in atlas.config.json.");
      return false;
    }
    log("Add this line with `crontab -e` (it runs hourly and writes rollups once a day, so a machine that was off catches up):\n");
    log(cronLine({ program, atlasDir: opts.atlasDir, at, log: logFile }));
    log(`\nThen set "rollups": "nightly" in ${join(opts.atlasDir, CONFIG_FILE)} so agents leave the rollups to the nightly run.`);
    writeNightlyState(opts.atlasDir, { installedAt: (opts.now ?? new Date()).toISOString() });
    return false;
  }

  const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  if (opts.remove) {
    if (!existsSync(plist)) {
      log("No nightly run is installed.");
      return false;
    }
    if (!opts.yes && !(await confirm(`Remove ${plist} and set "rollups" back to "agent"? [y/N] `))) return false;
    try {
      execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
    } catch {
      // not loaded
    }
    rmSync(plist, { force: true });
    rmSync(new AtlasPaths(opts.atlasDir).nightlyFile, { force: true });
    setRollupMode(opts.atlasDir, "agent");
    log("Removed. Agents will do rollups again.");
    return true;
  }

  const claude = findOnPath(opts.config.tidy.command);
  if (!claude) throw new Error(`Cannot find "${opts.config.tidy.command}" on PATH. Install Claude Code, or set tidy.command in atlas.config.json.`);
  const path = [...new Set([dirname(claude), dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"])].join(":");
  const text = launchdPlist({ program, atlasDir: opts.atlasDir, at, path, log: logFile });
  const { model, maxTokens, maxUsd } = opts.config.tidy;

  log(`Every night at ${at}, run:\n  ${program.join(" ")}\n`);
  log("If the Mac is off or asleep then, the run happens at the next login or wake instead, once a day.");
  log("Installing starts a first run now if today's has not happened yet.\n");
  log(`Each run writes pending rollups with ${claude} (model ${model}) and stops at ${maxTokens} tokens or $${maxUsd.toFixed(2)}, whichever comes first.`);
  log(`Change those limits under "tidy" in ${join(opts.atlasDir, CONFIG_FILE)}.\n`);
  log(`Files written:\n  ${plist} (launchd job)\n  ${join(opts.atlasDir, CONFIG_FILE)} ("rollups": "nightly", so agents stop doing rollups)`);
  log(`Output goes to ${logFile}; every rollup is logged with its cost in ${join(opts.atlasDir, ".atlas", "tidy.log")}.`);
  if (!opts.yes && !(await confirm("\nInstall the nightly run? [y/N] "))) {
    log("Nothing written.");
    return false;
  }
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });
  writeFileSync(plist, text);
  writeNightlyState(opts.atlasDir, { installedAt: (opts.now ?? new Date()).toISOString() });
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  } catch {
    // not loaded yet
  }
  execFileSync("launchctl", ["bootstrap", domain, plist]);
  setRollupMode(opts.atlasDir, "nightly");
  log(`\nInstalled. Remove it with: temporal-atlas install nightly --remove`);
  return true;
}
