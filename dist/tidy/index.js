import { appendFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { CHILD_ENV } from "../cli/hook.js";
import { tokens } from "../config.js";
import { scanEdits } from "../edits.js";
import { allScopes } from "../periods.js";
import { lengthTarget, lockKey, pending, seal, summarize } from "../rollup/index.js";
import { releaseLock } from "../store/lock.js";
export class ModelError extends Error {
    costUsd;
    budget;
    constructor(message, costUsd = 0, budget = false) {
        super(message);
        this.costUsd = costUsd;
        this.budget = budget;
    }
}
const SYSTEM = "You write summary notes for a personal work log. Reply with the note only, in the exact format the request gives. Do not use tools.";
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** Arguments for one `claude -p` call: no tools, no MCP servers, no user hooks, no saved transcript. */
export function claudeArgs(model, maxUsd) {
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
/** Run each rollup through the Claude Code CLI the user already has signed in. */
export function claudeRunner(atlas) {
    return (prompt, opts) => new Promise((resolve, reject) => {
        mkdirSync(atlas.paths.stateDir, { recursive: true });
        const child = spawn(atlas.config.tidy.command, claudeArgs(opts.model, opts.maxUsd), {
            cwd: atlas.paths.stateDir,
            env: { ...process.env, [CHILD_ENV]: "1" },
            stdio: ["pipe", "pipe", "pipe"],
        });
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
            let j;
            try {
                j = JSON.parse(out);
            }
            catch {
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
export function parseReply(text) {
    const body = text.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1").trim();
    const m = /^\**headline:?\**:?\s*(.+)\n+([\s\S]+)$/i.exec(body);
    if (!m || !m[2].trim())
        throw new ModelError("the reply did not start with a Headline line followed by the note");
    return { headline: m[1].replace(/\*+$/, "").trim(), content: m[2].trim() };
}
/** The rollups a tidy run would do now, in order, with their input estimates. Items waiting on others are included. */
export function tidyPlan(atlas, opts = {}) {
    const scopes = opts.scopes ?? allScopes(atlas);
    for (const s of scopes)
        scanEdits(atlas, s);
    return pending(atlas, scopes).items.filter((i) => opts.orphans || i.layer !== "session");
}
export async function tidy(atlas, opts) {
    const owner = `tidy-${process.pid}`;
    const scopes = opts.scopes ?? allScopes(atlas);
    const tried = new Set();
    const outcomes = [];
    let spentTokens = 0;
    let spentUsd = 0;
    let stoppedBecause;
    const say = opts.onProgress ?? (() => { });
    const next = () => tidyPlan(atlas, { scopes, orphans: opts.orphans }).filter((i) => !i.blocked && !tried.has(`${i.scope}/${i.period}`));
    for (let items = next(); items.length; items = next()) {
        const item = items[0];
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
        const ask = async (prompt) => {
            try {
                const r = await opts.runner(prompt, { model: opts.model, maxUsd: opts.maxUsd - spentUsd - cost });
                used += (r.inputTokens ?? tokens(prompt)) + (r.outputTokens ?? tokens(r.text));
                cost += r.costUsd ?? 0;
                return r.text;
            }
            catch (e) {
                if (e instanceof ModelError)
                    cost += e.costUsd;
                throw e;
            }
        };
        const record = (o) => {
            spentTokens += used;
            spentUsd += cost;
            const outcome = { scope: item.scope, period: item.period, layer: item.layer, tokens: used, costUsd: cost, ...o };
            outcomes.push(outcome);
            logTidy(atlas, outcome);
            say(`${o.result === "sealed" ? "sealed" : "failed"} ${item.scope} ${item.period} (${item.layer}, ${used} tokens, $${cost.toFixed(3)})${o.reason ? `: ${o.reason}` : ""}`);
        };
        let job;
        try {
            job = summarize(atlas, owner, item.scope, item.period, true, "reply");
        }
        catch (e) {
            record({ result: "failed", reason: e instanceof Error ? e.message : String(e) });
            continue;
        }
        const prompt = `${job.instructions}\n\n# Sources for ${job.period} (${job.layer}, scope ${job.scope})\n\n${job.sources}`;
        try {
            let reply = parseReply(await ask(prompt));
            try {
                seal(atlas, owner, item.scope, { period: item.period, ...reply });
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (!/Shorten it/.test(msg))
                    throw e;
                reply = parseReply(await ask(`${prompt}\n\nYour first version was too long: ${msg}\nRewrite it in the same format.\n\n${reply.content}`));
                seal(atlas, owner, item.scope, { period: item.period, ...reply });
            }
            record({ result: "sealed" });
        }
        catch (e) {
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
function logTidy(atlas, outcome) {
    const file = atlas.paths.tidyLog;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: atlas.stamp(), ...outcome })}\n`);
}
