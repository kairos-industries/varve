import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { isInside } from "../config.js";
import { dayOf, wallClock } from "../time/index.js";
export function newCaptureState() {
    return { offset: 0, humanTurns: 0, programTurns: 0, days: {} };
}
const FIRST_ASKS = 3;
const LAST_ASKS = 5;
const ASK_CHARS = 300;
const REPLY_CHARS = 600;
const MAX_FILES = 200;
const MAX_MILESTONES = 30;
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Read whole JSONL lines added after `offset`. A partly written last line is left for the next call. */
export function readNewLines(path, offset) {
    if (!existsSync(path))
        return { lines: [], offset };
    const fd = openSync(path, "r");
    try {
        const size = fstatSync(fd).size;
        const start = size < offset ? 0 : offset;
        if (size === start)
            return { lines: [], offset: start };
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        const end = buf.lastIndexOf(0x0a);
        if (end < 0)
            return { lines: [], offset: start };
        const lines = buf.subarray(0, end).toString("utf8").split("\n");
        return { lines, offset: start + end + 1 };
    }
    finally {
        closeSync(fd);
    }
}
function oneLine(text, max) {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}
/** What a person asked in one user entry, or undefined for tool results and injected text. */
export function askText(entry) {
    if (entry.isMeta)
        return undefined;
    const content = entry.message?.content;
    let text;
    if (typeof content === "string")
        text = content;
    else if (Array.isArray(content)) {
        if (content.some((b) => b.type === "tool_result"))
            return undefined;
        text = content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text)
            .join("\n");
    }
    else
        return undefined;
    const command = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text)?.[1];
    if (command) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
        return `${command}${args ? ` ${args}` : ""}`;
    }
    const stripped = text.replace(/<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, "").trim();
    if (!stripped || stripped.startsWith("<") || stripped.startsWith("[Request interrupted") || stripped.startsWith("Caveat:"))
        return undefined;
    return stripped;
}
/** A commit, push, PR or release worth listing, from one shell command. */
export function milestone(command) {
    const heredoc = /git\b[^\n;&|]*\bcommit\b[\s\S]*?<<\s*['"]?EOF['"]?\s*\n\s*([^\n]+)/.exec(command);
    if (heredoc)
        return `commit: ${heredoc[1].trim()}`;
    const commit = /git\b[^\n;&|]*\bcommit\b[^\n;&|]*?\s-[a-zA-Z]*m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(command);
    if (commit)
        return `commit: ${(commit[1] ?? commit[2] ?? "").split("\n")[0].trim()}`;
    const pr = /\bgh\s+pr\s+create\b[\s\S]*?--title\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(command);
    if (pr)
        return `opened PR: ${(pr[1] ?? pr[2] ?? "").trim()}`;
    const merged = /\bgh\s+pr\s+merge\s+(\S+)/.exec(command);
    if (merged)
        return `merged PR ${merged[1]}`;
    const push = /\bgit\s+push\b([^\n;&|]*)/.exec(command);
    if (push)
        return `pushed${push[1].trim() ? ` (${oneLine(push[1], 80)})` : ""}`;
    if (/\bnpm\s+publish\b/.test(command) && !/\s--dry-run\b/.test(command))
        return "published to npm";
    return undefined;
}
function day(state, id) {
    state.days[id] ??= { firstAsks: [], lastAsks: [], asks: 0, files: [], milestones: [], toolCalls: 0 };
    return state.days[id];
}
/** Fold transcript lines into the capture state. */
export function absorb(state, lines, config) {
    let stamp = state.stamp;
    for (const raw of lines) {
        if (!raw.trim())
            continue;
        let e;
        try {
            e = JSON.parse(raw);
        }
        catch {
            continue;
        }
        if (e.type === "ai-title" && e.aiTitle)
            state.title = oneLine(e.aiTitle, 120);
        if (e.cwd)
            state.cwd = e.cwd;
        if (e.timestamp)
            stamp = e.timestamp;
        if (e.isSidechain || !stamp || (e.type !== "user" && e.type !== "assistant"))
            continue;
        const at = new Date(stamp);
        if (Number.isNaN(at.getTime()))
            continue;
        const d = day(state, dayOf(at, config));
        const time = wallClock(at, config).time;
        if (e.type === "user") {
            const ask = askText(e);
            if (!ask)
                continue;
            if (e.turnOrigin === "human")
                state.humanTurns++;
            else if (e.turnOrigin === "sdk")
                state.programTurns++;
            d.asks++;
            const item = { time, text: oneLine(ask, ASK_CHARS) };
            if (d.firstAsks.length < FIRST_ASKS)
                d.firstAsks.push(item);
            else
                d.lastAsks = [...d.lastAsks, item].slice(-LAST_ASKS);
            continue;
        }
        const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
        for (const b of blocks) {
            if (b.type === "text" && b.text?.trim())
                d.lastReply = { time, text: oneLine(b.text, REPLY_CHARS) };
            if (b.type !== "tool_use")
                continue;
            d.toolCalls++;
            const input = b.input ?? {};
            if (b.name && FILE_TOOLS.has(b.name)) {
                const file = String(input.file_path ?? input.notebook_path ?? "");
                if (file) {
                    const shown = state.cwd && isAbsolute(file) && isInside(file, [state.cwd]) ? relative(state.cwd, file).replace(/\\/g, "/") : file;
                    if (!d.files.includes(shown) && d.files.length < MAX_FILES)
                        d.files.push(shown);
                }
            }
            if (b.name === "Bash" && typeof input.command === "string") {
                const m = milestone(input.command);
                if (m)
                    d.milestones = [...d.milestones, { time, text: oneLine(m, 160) }].slice(-MAX_MILESTONES);
            }
        }
    }
    state.stamp = stamp;
}
/** True when every prompt came from a program rather than a person. */
export function isHeadless(state) {
    return state.programTurns > 0 && state.humanTurns === 0;
}
export function hasActivity(state) {
    return Object.values(state.days).some((d) => d.asks > 0);
}
/** The Markdown for one day's `### Activity` section. The first line is the session title when known. */
export function renderActivity(state, dayId) {
    const d = state.days[dayId];
    if (!d || d.asks === 0)
        return undefined;
    const out = [];
    if (state.title)
        out.push(state.title, "");
    for (const a of d.firstAsks)
        out.push(`- ${a.time} asked: ${a.text}`);
    const skipped = d.asks - d.firstAsks.length - d.lastAsks.length;
    if (skipped > 0)
        out.push(`- (${skipped} more request${skipped === 1 ? "" : "s"})`);
    for (const a of d.lastAsks)
        out.push(`- ${a.time} asked: ${a.text}`);
    if (d.files.length) {
        const shown = d.files.slice(0, 15).map((f) => `\`${f}\``).join(", ");
        out.push(`- files changed (${d.files.length}): ${shown}${d.files.length > 15 ? ", ..." : ""}`);
    }
    for (const m of d.milestones.slice(-10))
        out.push(`- ${m.time} ${m.text}`);
    if (d.lastReply)
        out.push(`- ${d.lastReply.time} last reply: ${d.lastReply.text}`);
    out.push(`- ${d.asks} request${d.asks === 1 ? "" : "s"}, ${d.toolCalls} tool call${d.toolCalls === 1 ? "" : "s"}`);
    return out.join("\n");
}
/** Read a whole transcript into a fresh state, for backfilling sessions recorded before capture existed. */
export function captureTranscript(path, config) {
    const state = newCaptureState();
    const { lines, offset } = readNewLines(path, 0);
    absorb(state, lines, config);
    state.offset = offset;
    return state;
}
