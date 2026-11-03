import { appendFileSync, mkdirSync } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import spawn from "cross-spawn";
import { dirname } from "node:path";
import type { Atlas } from "../atlas.js";
import { CHILD_ENV } from "../cli/hook.js";
import { tokens } from "../config.js";
import { scanEdits } from "../edits.js";
import { allScopes } from "../periods.js";
import { lengthTarget, lockKey, type PendingItem, pending, seal, summarize } from "../rollup/index.js";
import { releaseLock } from "../store/lock.js";

/**
 * The nightly tidy: write pending rollups with a model, one call per rollup, inside a token
 * and dollar budget. This is the only part of Temporal Atlas that calls a model, and it runs
 * only when the user starts it or schedules it (ADR 0004).
 */

export interface ModelReply {
  text: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type ModelRunner = (prompt: string, opts: { model: string; maxUsd: number }) => Promise<ModelReply>;

export class ModelError extends Error {
  constructor(
    message: string,
    readonly costUsd = 0,
    readonly budget = false,
  ) {
    super(message);
  }
}

const SYSTEM = "You write summary notes for a personal work log. Reply with the note only, in the exact format the request gives. Do not use tools.";
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Arguments for one `claude -p` call: no tools, no MCP servers, no user hooks, no saved transcript. */
export function claudeArgs(model: string, maxUsd: number): string[] {
  return [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources", "project",
    "--tools", "",
    "--max-budget-usd", Math.max(0.01, maxUsd).toFixed(2),
    "--system-prompt", SYSTEM,
  ];
}

/** Run each rollup through the Claude Code CLI the user already has signed in. cross-spawn also runs a claude.cmd shim on Windows. */
export function claudeRunner(atlas: Atlas): ModelRunner {
  return (prompt, opts) =>
    new Promise((resolve, reject) => {
      mkdirSync(atlas.paths.stateDir, { recursive: true });
      const child = spawn(atlas.config.tidy.command, claudeArgs(opts.model, opts.maxUsd), {
        cwd: atlas.paths.stateDir,
        env: { ...process.env, [CHILD_ENV]: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new ModelError(`could not run ${atlas.config.tidy.command}: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let j: { result?: string; is_error?: boolean; subtype?: string; total_cost_usd?: number; usage?: Record<string, number> };
        try {
          j = JSON.parse(out);
        } catch {
          reject(new ModelError(`${atlas.config.tidy.command} exited with code ${code}: ${(err || out).trim().slice(0, 300)}`));
          return;
        }
        const cost = j.total_cost_usd ?? 0;
        if (j.is_error || j.subtype !== "success" || typeof j.result !== "string") {
          const budget = /budget/i.test(String(j.subtype));
          reject(new ModelError(`${atlas.config.tidy.command}: ${j.subtype ?? "error"} ${String(j.result ?? "").slice(0, 300)}`.trim(), cost, budget));
          return;
        }
        const u = j.usage ?? {};
        resolve({
          text: j.result,
          costUsd: cost,
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) || undefined,
          outputTokens: u.output_tokens,
        });
      });
      child.stdin.end(prompt);
    });
}

/** Split a reply into its headline and note. */
export function parseReply(text: string): { headline: string; content: string } {
  const body = text.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1").trim();
  const m = /^\**headline:?\**:?\s*(.+)\n+([\s\S]+)$/i.exec(body);
  if (!m || !m[2]!.trim()) throw new ModelError("the reply did not start with a Headline line followed by the note");
  return { headline: m[1]!.replace(/\*+$/, "").trim(), content: m[2]!.trim() };
}

export interface TidyOptions {
  runner: ModelRunner;
  model: string;
  maxTokens: number;
  maxUsd: number;
  scopes?: string[];
  /** Also summarize orphan sessions from their transcripts. Off by default: transcripts are large. */
  orphans?: boolean;
  onProgress?: (line: string) => void;
}

export interface TidyOutcome {
  scope: string;
  period: string;
  layer: string;
  result: "sealed" | "failed";
  reason?: string;
  tokens: number;
  costUsd: number;
}

export interface TidyReport {
  outcomes: TidyOutcome[];
  spentTokens: number;
  spentUsd: number;
  stoppedBecause?: string;
  left: number;
}

/** The rollups a tidy run would do now, in order, with their input estimates. Items waiting on others are included. */
export function tidyPlan(atlas: Atlas, opts: { scopes?: string[]; orphans?: boolean } = {}): PendingItem[] {
  const scopes = opts.scopes ?? allScopes(atlas);
  for (const s of scopes) scanEdits(atlas, s);
  return pending(atlas, scopes).items.filter((i) => opts.orphans || i.layer !== "session");
}

export async function tidy(atlas: Atlas, opts: TidyOptions): Promise<TidyReport> {
  const owner = `tidy-${process.pid}`;
  const scopes = opts.scopes ?? allScopes(atlas);
  const tried = new Set<string>();
  const outcomes: TidyOutcome[] = [];
  let spentTokens = 0;
  let spentUsd = 0;
  let stoppedBecause: string | undefined;
  const say = opts.onProgress ?? (() => {});

  const next = () => tidyPlan(atlas, { scopes, orphans: opts.orphans }).filter((i) => !i.blocked && !tried.has(`${i.scope}/${i.period}`));

  for (let items = next(); items.length; items = next()) {
    const item = items[0]!;
    const expected = item.tokens + lengthTarget(atlas, item.layer);
    if (spentTokens + expected > opts.maxTokens) {
      stoppedBecause = `the next rollup (${item.period}, about ${expected} tokens with its reply) would pass the ${opts.maxTokens}-token budget`;
      break;
    }
    if (spentUsd >= opts.maxUsd) {
      stoppedBecause = `the $${opts.maxUsd.toFixed(2)} budget is spent`;
      break;
    }
    tried.add(`${item.scope}/${item.period}`);
    let used = 0;
    let cost = 0;
    const ask = async (prompt: string) => {
      try {
        const r = await opts.runner(prompt, { model: opts.model, maxUsd: opts.maxUsd - spentUsd - cost });
        used += (r.inputTokens ?? tokens(prompt)) + (r.outputTokens ?? tokens(r.text));
        cost += r.costUsd ?? 0;
        return r.text;
      } catch (e) {
        if (e instanceof ModelError) cost += e.costUsd;
        throw e;
      }
    };
    const record = (o: Omit<TidyOutcome, "scope" | "period" | "layer" | "tokens" | "costUsd">) => {
      spentTokens += used;
      spentUsd += cost;
      const outcome = { scope: item.scope, period: item.period, layer: item.layer, tokens: used, costUsd: cost, ...o };
      outcomes.push(outcome);
      logTidy(atlas, outcome);
      say(`${o.result === "sealed" ? "sealed" : "failed"} ${item.scope} ${item.period} (${item.layer}, ${used} tokens, $${cost.toFixed(3)})${o.reason ? `: ${o.reason}` : ""}`);
    };

    let job: ReturnType<typeof summarize>;
    try {
      job = summarize(atlas, owner, item.scope, item.period, true, "reply");
    } catch (e) {
      record({ result: "failed", reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const prompt = `${job.instructions}\n\n# Sources for ${job.period} (${job.layer}, scope ${job.scope})\n\n${job.sources}`;
    try {
      let reply = parseReply(await ask(prompt));
      try {
        seal(atlas, owner, item.scope, { period: item.period, ...reply });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/Shorten it/.test(msg)) throw e;
        reply = parseReply(await ask(`${prompt}\n\nYour first version was too long: ${msg}\nRewrite it in the same format.\n\n${reply.content}`));
        seal(atlas, owner, item.scope, { period: item.period, ...reply });
      }
      record({ result: "sealed" });
    } catch (e) {
      releaseLock(atlas.paths.locksDir, lockKey(item.scope, item.period));
      record({ result: "failed", reason: e instanceof Error ? e.message : String(e) });
      if (e instanceof ModelError && e.budget) {
        stoppedBecause = "claude stopped at the dollar budget";
        break;
      }
    }
  }
  const left = tidyPlan(atlas, { scopes, orphans: opts.orphans }).length;
  return { outcomes, spentTokens, spentUsd, stoppedBecause, left };
}

function logTidy(atlas: Atlas, outcome: TidyOutcome) {
  const file = atlas.paths.tidyLog;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: atlas.stamp(), ...outcome })}\n`);
}
