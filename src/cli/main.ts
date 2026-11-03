#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Atlas } from "../atlas.js";
import { CONFIG_FILE, DEFAULT_CONFIG, INIT_KEYS } from "../config.js";
import { atlasDir, runStdio } from "../server/index.js";
import { VERSION } from "../version.js";
import { NAME } from "../names.js";
import { MODEL, modelDir, modelInstalled, pullModel } from "../embed/index.js";
import { benchFixture, benchOwn, formatReport, ownProbes, paraphrase, paraphraseTokens } from "../bench/index.js";
import { allScopes } from "../periods.js";
import { claudeRunner, tidy, tidyPlan } from "../tidy/index.js";
import { backfill, formatBackfill } from "./backfill.js";
import { doctor, formatDoctor } from "./doctor.js";
import { type HookPayload, runHook } from "./hook.js";
import { installClaudeCode, installCodex, serverCommand } from "./install.js";
import { installNightly, readNightlyState, writeNightlyState } from "./nightly.js";
import { setup, uninstall } from "./setup.js";

const HELP = `varve ${VERSION}

Usage:
  varve                      Run the MCP server over stdio
  varve setup                Set up everything for Claude Code in one go (asks before each part)
                                        --dir <path>         atlas folder (default: $VARVE_DIR or ~/Varve)
                                        --isolate | --no-isolate   keep each project's memory apart (default: yes)
                                        --nightly            also schedule the nightly summaries
                                        --yes                use the defaults without asking
  varve uninstall            Remove the hooks, the MCP registration and the nightly run; keeps your notes
  varve init [dir]           Create an atlas (default: $VARVE_DIR or ~/Varve)
  varve install claude-code  Add the capture hooks to ~/.claude/settings.json (asks first; --yes to skip)
  varve install codex        Add the capture hooks to ~/.codex/hooks.json (asks first; --yes to skip)
  varve install nightly      Schedule \`tidy --scheduled\` every night, catching up after the computer was off (asks first; --at HH:MM, --remove)
  varve tidy                 Write pending rollups with \`claude -p\`, within a token and dollar budget
                                        --dry-run            show the plan and estimate, write nothing
                                        --yes                run without asking
                                        --scheduled          run without asking, at most once per atlas day (used by the schedule)
                                        --scope <name>       only this scope (repeatable)
                                        --model <name>       default from atlas.config.json (tidy.model)
                                        --max-tokens <n>     default tidy.maxTokens
                                        --max-usd <amount>   default tidy.maxUsd
                                        --orphans            also summarize orphan sessions from transcripts
  varve backfill             Record activity for older sessions from their transcripts (no model)
                                        --dry-run            report what would change
                                        --prune              delete headless runs instead of marking them skipped
  varve models pull          Download the search model (${MODEL.name}, about 30 MB, once) so search matches by meaning
  varve models status        Show whether the search model is installed
  varve bench                How well search and the brief bring back past work, on your atlas (read only, no model)
                                        --fixture            on the bundled example atlas instead, the same for everyone
                                        --json               print the report as JSON
                                        --out <file>         where to save the report (default .atlas/bench/)
                                        --max <n>            at most this many probes from your atlas (default 200)
                                        --sweep              also score search at several similarity thresholds
                                        --paraphrase         have a model reword the queries first (paid; asks first)
                                          --model <name>       default haiku
                                          --max-usd <amount>   default 0.25
  varve doctor               Check the atlas: backlog, unrecorded sessions, hooks, broken notes
  varve hook <event>         Used by the hooks: session-start, stop or session-end, payload on stdin (--client codex for Codex)

Every command takes --dir <path> for the atlas folder instead of $VARVE_DIR.
Models are kept in $VARVE_MODELS, default ~/.cache/varve/models.
`;

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

function options(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
}

function number(args: string[], name: string, fallback: number): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} takes a number, not "${raw}".`);
  return n;
}

async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

async function runTidy(args: string[]) {
  const atlas = new Atlas({ dir: atlasDir() });
  const cfg = atlas.config.tidy;
  const scopes = options(args, "--scope");
  const opts = {
    model: option(args, "--model") ?? cfg.model,
    maxTokens: number(args, "--max-tokens", cfg.maxTokens),
    maxUsd: number(args, "--max-usd", cfg.maxUsd),
    scopes: scopes.length ? scopes : undefined,
    orphans: flag(args, "--orphans"),
  };
  // A scheduled run fires at the set time, at login and hourly; only the first one in an atlas day works.
  const scheduled = flag(args, "--scheduled");
  const today = atlas.today();
  if (scheduled && readNightlyState(atlas.root).lastRunDay === today) return;
  const ran = (result: string) => scheduled && writeNightlyState(atlas.root, { lastRunAt: atlas.stamp(), lastRunDay: today, lastResult: result });

  const plan = tidyPlan(atlas, opts);
  const total = plan.reduce((sum, i) => sum + i.tokens, 0);
  console.log(`[${atlas.stamp()}] ${plan.length} rollup(s) pending, about ${total} input tokens.`);
  console.log(`Budget for this run: ${opts.maxTokens} tokens or $${opts.maxUsd.toFixed(2)}, model ${opts.model}.`);
  if (!plan.length) {
    ran("nothing pending");
    return;
  }
  if (flag(args, "--dry-run")) {
    for (const i of plan) console.log(`  ${i.scope} ${i.period} (${i.layer}, about ${i.tokens} tokens${i.blocked ? ", after the ones it waits on" : ""})`);
    console.log("\nNothing was written.");
    return;
  }
  if (!flag(args, "--yes") && !scheduled) {
    if (!process.stdin.isTTY) throw new Error("Pass --yes to run tidy without asking (for example from a schedule).");
    if (!(await confirm("Write these rollups now? [y/N] "))) {
      console.log("Nothing written.");
      return;
    }
  }
  const report = await tidy(atlas, { ...opts, runner: claudeRunner(atlas), onProgress: (line) => console.log(`  ${line}`) });
  const sealed = report.outcomes.filter((o) => o.result === "sealed").length;
  const failed = report.outcomes.length - sealed;
  console.log(`\nSealed ${sealed}, failed ${failed}; used ${report.spentTokens} tokens, $${report.spentUsd.toFixed(3)}. ${report.left} left.`);
  if (report.stoppedBecause) console.log(`Stopped early: ${report.stoppedBecause}.`);
  // A run that never reached the model (offline, signed out) is not counted, so the next hour tries again.
  if (sealed || report.spentUsd > 0) ran(`sealed ${sealed}, failed ${failed}, $${report.spentUsd.toFixed(3)}`);
}

async function runBench(args: string[]) {
  const json = flag(args, "--json");
  const show = (r: Parameters<typeof formatReport>[0]) => console.log(json ? JSON.stringify(r, null, 2) : formatReport(r));
  const save = (r: object, fallbackDir: string) => {
    const out = option(args, "--out") ?? join(fallbackDir, `bench-${new Date().toISOString().slice(0, 10)}.json`);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
    if (!json) console.log(`\nReport saved to ${out}. It holds numbers only: no note text, no project names.`);
  };
  if (flag(args, "--fixture")) {
    const r = benchFixture(undefined, { sweep: flag(args, "--sweep") });
    show(r);
    if (option(args, "--out")) save(r, ".");
    return;
  }
  const atlas = new Atlas({ dir: atlasDir() });
  const reportDir = join(atlas.paths.stateDir, "bench");
  const max = number(args, "--max", 200);
  if (!flag(args, "--paraphrase")) {
    const r = benchOwn(atlas, { max, sweep: flag(args, "--sweep") });
    show(r);
    save(r, reportDir);
    return;
  }
  const probes = ownProbes(atlas, allScopes(atlas), max);
  const model = option(args, "--model") ?? "haiku";
  const maxUsd = number(args, "--max-usd", 0.25);
  console.log(`Paraphrasing ${probes.length} queries with ${model} through \`${atlas.config.tidy.command} -p\`: about ${paraphraseTokens(probes)} input tokens, stopped at $${maxUsd.toFixed(2)}.`);
  console.log("Only the queries are sent (one clause of a logged event, or a summary headline), through your own Claude Code sign-in.");
  if (!flag(args, "--yes")) {
    if (!process.stdin.isTTY) throw new Error("Pass --yes to run the paraphrase tier without asking.");
    if (!(await confirm("Run it? [y/N] "))) {
      console.log("Nothing sent.");
      return;
    }
  }
  const rewritten = await paraphrase(probes, claudeRunner(atlas), { model, maxUsd });
  const r = { ...benchOwn(atlas, { probes: rewritten.probes, dataset: "own-paraphrased", sweep: flag(args, "--sweep") }), paraphrase: { model, costUsd: rewritten.costUsd, rewritten: rewritten.probes.length } };
  show(r);
  save(r, reportDir);
}

function init(dir: string) {
  mkdirSync(join(dir, ".atlas"), { recursive: true });
  const config = join(dir, CONFIG_FILE);
  if (!existsSync(config)) {
    const initial = Object.fromEntries(INIT_KEYS.map((k) => [k, DEFAULT_CONFIG[k]]));
    writeFileSync(config, `${JSON.stringify(initial, null, 2)}\n`);
  }
  const [command, ...args] = serverCommand(fileURLToPath(import.meta.url));
  const line = [command, ...args].map((a) => JSON.stringify(a)).join(" ");
  console.log(`Atlas ready at ${dir}

Connect it to an agent:
  Claude Code:  claude mcp add varve --scope user -e VARVE_DIR=${JSON.stringify(dir)} -- ${line}
  Codex:        codex mcp add varve --env VARVE_DIR=${JSON.stringify(dir)} -- ${line}
  Others:       command ${JSON.stringify(command)}, args ${JSON.stringify(args)}, env VARVE_DIR=${JSON.stringify(dir)}

For automatic capture in Claude Code:  varve install claude-code
For automatic capture in Codex:        varve install codex
To write rollups overnight:            varve install nightly`);
}

async function main(argv: string[]) {
  // `--dir` anywhere sets the folder, for places that cannot set VARVE_DIR (Windows hooks and tasks).
  const at = argv.indexOf("--dir");
  if (at >= 0) {
    process.env.VARVE_DIR = option(argv, "--dir");
    delete process.env.TEMPORAL_ATLAS_DIR;
    argv = argv.filter((_, i) => i !== at && i !== at + 1);
  }
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "serve":
      return runStdio();
    case "init":
      return init(resolve(rest[0] ?? atlasDir()));
    case "install": {
      const script = fileURLToPath(import.meta.url);
      const yes = flag(rest, "--yes");
      if (rest[0] === "claude-code") {
        await installClaudeCode({ atlasDir: resolve(atlasDir()), script, yes });
        return;
      }
      if (rest[0] === "codex") {
        await installCodex({ atlasDir: resolve(atlasDir()), script, yes });
        return;
      }
      if (rest[0] === "nightly") {
        const dir = resolve(atlasDir());
        await installNightly({ atlasDir: dir, script, config: new Atlas({ dir }).config, at: option(rest, "--at"), yes, remove: flag(rest, "--remove") });
        return;
      }
      throw new Error("Use `install claude-code`, `install codex` or `install nightly`.");
    }
    case "setup": {
      const dir = resolve(atlasDir());
      const isolate = flag(rest, "--isolate") ? true : flag(rest, "--no-isolate") ? false : undefined;
      await setup({ dir, script: fileURLToPath(import.meta.url), yes: flag(rest, "--yes"), isolate, nightly: flag(rest, "--nightly") || undefined });
      return;
    }
    case "uninstall":
      await uninstall({ dir: resolve(atlasDir()), script: fileURLToPath(import.meta.url), yes: flag(rest, "--yes") });
      return;
    case "models": {
      const dir = modelDir();
      if (rest[0] === "pull") {
        const bytes = await pullModel(dir, fetch, (l) => console.log(l));
        console.log(bytes ? `Saved ${MODEL.name} (${(bytes / 1e6).toFixed(1)} MB) to ${dir}. Search now matches by meaning too.` : `${MODEL.name} is already installed at ${dir}.`);
        return;
      }
      if (rest[0] === undefined || rest[0] === "status") {
        console.log(modelInstalled(dir) ? `${MODEL.name} installed at ${dir}. Search matches by keyword and by meaning.` : `No embedding model at ${dir}. Search is keyword only. Run \`varve models pull\` (about 30 MB, once).`);
        return;
      }
      throw new Error("Use `models pull` or `models status`.");
    }
    case "tidy":
      return runTidy(rest);
    case "bench":
      return runBench(rest);
    case "backfill":
      console.log(formatBackfill(backfill(new Atlas({ dir: atlasDir() }), { dryRun: flag(rest, "--dry-run"), prune: flag(rest, "--prune") })));
      return;
    case "doctor":
      console.log(formatDoctor(doctor(new Atlas({ dir: atlasDir() }))));
      return;
    case "hook": {
      // A hook must never break the agent: report problems on stderr and exit 0.
      try {
        const raw = readFileSync(0, "utf8");
        runHook(new Atlas({ dir: atlasDir() }), rest[0] ?? "", raw.trim() ? (JSON.parse(raw) as HookPayload) : {}, process.env, option(rest, "--client") ?? "claude-code");
      } catch (err) {
        process.stderr.write(`varve hook: ${err instanceof Error ? err.message : String(err)}\n`);
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
