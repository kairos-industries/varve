#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Atlas } from "../atlas.js";
import { CONFIG_FILE, DEFAULT_CONFIG } from "../config.js";
import { atlasDir, runStdio } from "../server/index.js";
import { VERSION } from "../version.js";
import { doctor, formatDoctor } from "./doctor.js";
import { type HookPayload, runHook } from "./hook.js";
import { installClaudeCode } from "./install.js";

const HELP = `temporal-atlas ${VERSION}

Usage:
  temporal-atlas                      Run the MCP server over stdio
  temporal-atlas init [dir]           Create an atlas (default: $TEMPORAL_ATLAS_DIR or ~/TemporalAtlas)
  temporal-atlas install claude-code  Add the capture hooks to ~/.claude/settings.json (asks first; --yes to skip)
  temporal-atlas doctor               Check the atlas for pending rollups, orphan sessions and broken notes
  temporal-atlas hook <event>         Used by the hooks: session-start or session-end, payload on stdin
`;

function init(dir: string) {
  mkdirSync(join(dir, ".atlas"), { recursive: true });
  const config = join(dir, CONFIG_FILE);
  if (!existsSync(config)) {
    const { timezone, dayBoundary, costGateTokens, lengthTargets, briefTokens, scrubPatterns } = DEFAULT_CONFIG;
    writeFileSync(config, `${JSON.stringify({ timezone, dayBoundary, costGateTokens, lengthTargets, briefTokens, scrubPatterns }, null, 2)}\n`);
  }
  console.log(`Atlas ready at ${dir}

Connect it to an agent:
  Claude Code:  claude mcp add temporal-atlas --scope user -e TEMPORAL_ATLAS_DIR=${JSON.stringify(dir)} -- npx -y temporal-atlas
  Codex:        codex mcp add temporal-atlas --env TEMPORAL_ATLAS_DIR=${JSON.stringify(dir)} -- npx -y temporal-atlas
  Others:       command "npx", args ["-y", "temporal-atlas"], env TEMPORAL_ATLAS_DIR=${JSON.stringify(dir)}

For automatic capture in Claude Code:  temporal-atlas install claude-code`);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "serve":
      return runStdio();
    case "init":
      return init(resolve(rest[0] ?? atlasDir()));
    case "install":
      if (rest[0] !== "claude-code") throw new Error("Only `install claude-code` is supported so far.");
      await installClaudeCode({ atlasDir: resolve(atlasDir()), script: fileURLToPath(import.meta.url), yes: rest.includes("--yes") });
      return;
    case "doctor":
      console.log(formatDoctor(doctor(new Atlas({ dir: atlasDir() }))));
      return;
    case "hook": {
      // A hook must never break the agent: report problems on stderr and exit 0.
      try {
        const raw = readFileSync(0, "utf8");
        runHook(new Atlas({ dir: atlasDir() }), rest[0] ?? "", raw.trim() ? (JSON.parse(raw) as HookPayload) : {});
      } catch (err) {
        process.stderr.write(`temporal-atlas hook: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return;
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "--help":
    case "-h":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(HELP);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
