import { tokens } from "../config.js";
import { markParentsStale, refreshAround, renderSegmentSource, ScopeView, weekday, writeIndex } from "../periods.js";
import { isOrphan, parseSession, saveSession, sessionDays } from "../sessions/note.js";
import { statSync } from "node:fs";
import { transcriptText } from "../sessions/transcript.js";
import { lockHolder, releaseLock, takeLock } from "../store/lock.js";
import { link, readNote, writeFrontmatter, writeNote } from "../store/note.js";
import { isClosed, parsePeriod, rangeOf } from "../time/index.js";
const RANK = { session: 0, day: 1, week: 2, month: 3, year: 4 };
function orphanText(atlas, s) {
    return transcriptText(String(s.fm.transcript), atlas.config.transcriptMaxChars);
}
/** Token estimates for orphan transcripts, keyed by path and size, so a brief does not re-read large files. */
const orphanEstimates = new Map();
function orphanTokens(atlas, s) {
    const path = String(s.fm.transcript);
    let size = -1;
    try {
        size = statSync(path).size;
    }
    catch {
        return 0;
    }
    const key = `${path}:${size}:${atlas.config.transcriptMaxChars}`;
    let est = orphanEstimates.get(key);
    if (est === undefined) {
        est = tokens(orphanText(atlas, s));
        orphanEstimates.set(key, est);
    }
    return est;
}
/** Pending rollups for one scope, without gate marks. */
function scopeItems(atlas, scope) {
    const view = new ScopeView(atlas, scope);
    const now = atlas.now();
    const cfg = atlas.config;
    const targets = cfg.lengthTargets;
    const items = [];
    // Orphan sessions (recorded before activity capture, or by a client without it) can be
    // summarized from their transcripts, but no day waits for them: a day seals from what it has,
    // and becomes stale if an orphan summary arrives later.
    for (const s of view.sessions()) {
        if (!isOrphan(s))
            continue;
        const day = sessionDays(s)[0] ?? atlas.today();
        items.push({ scope, period: String(s.fm.session), layer: "session", tokens: orphanTokens(atlas, s), blocked: false, waitingOn: [], stale: false, until: day });
    }
    const sealedTokens = (period, fallback) => {
        const n = view.note(period);
        return n && view.isSealed(period) ? tokens(n.body) : fallback;
    };
    for (const day of view.workedDays()) {
        if (!isClosed(day, now, cfg) || view.status(day) === "sealed")
            continue;
        const segments = view.segmentsOn(day);
        const human = view.humanDraftText(day);
        if (!segments.length && !human)
            continue;
        const src = segments.map(renderSegmentSource).join("\n\n") + (human ?? "");
        items.push({ scope, period: day, layer: "day", tokens: tokens(src), blocked: false, waitingOn: [], stale: view.status(day) === "stale", until: day });
    }
    for (const layer of ["week", "month", "year"]) {
        for (const period of view.workedPeriods(layer)) {
            if (!isClosed(period, now, cfg) || view.status(period) === "sealed")
                continue;
            const children = view.childPeriods(period);
            const childTarget = layer === "year" ? targets.month : targets.day;
            const waitingOn = children.filter((c) => !view.isSealed(c) || view.status(c) === "stale");
            const est = children.reduce((sum, c) => sum + sealedTokens(c, childTarget), 0);
            items.push({ scope, period, layer, tokens: est, blocked: waitingOn.length > 0, waitingOn, stale: view.status(period) === "stale", until: rangeOf(period).last });
        }
    }
    return items;
}
/** Pending rollups across the given scopes, oldest first, lowest layer first, with cost-gate marks. */
export function pending(atlas, scopes) {
    const items = scopes
        .flatMap((s) => scopeItems(atlas, s))
        .sort((a, b) => a.until.localeCompare(b.until) || RANK[a.layer] - RANK[b.layer] || a.scope.localeCompare(b.scope));
    let running = 0;
    let open = true;
    const marked = items.map((item) => {
        running += item.tokens;
        if (running > atlas.config.costGateTokens)
            open = false;
        return { ...item, gate: open ? "auto" : "needs_confirmation" };
    });
    return { items: marked, totalTokens: running, gateTokens: atlas.config.costGateTokens };
}
export function lockKey(scope, period) {
    return `${scope}__${period}`;
}
function findItem(atlas, scope, period) {
    const item = pending(atlas, [scope]).items.find((i) => i.period === period);
    if (!item) {
        throw new Error(`${period} in scope "${scope}" is not pending: it is still open, already sealed, or has no work. Call pending() for the list.`);
    }
    return item;
}
export function lengthTarget(atlas, layer) {
    return layer === "session" ? atlas.config.lengthTargets.segment : atlas.config.lengthTargets[layer];
}
function writingInstructions(item, target, mode) {
    const what = item.layer === "session" ? `the summary of session ${item.period} from its transcript` : `the ${item.layer} note for ${item.period}`;
    return [
        `Write ${what} in scope "${item.scope}", about ${target} tokens (hard limit ${Math.round(target * 1.5)}).`,
        "Use these sections, leaving out any that would be empty:",
        "### What happened",
        "### Decisions (with the reason for each)",
        "### Open threads",
        "Keep names, numbers, files and decisions. Drop chatter and anything already obvious from the headline.",
        "Link sources with [[note name]] where a reader may want the detail.",
        ...(mode === "tool"
            ? [
                `Then call seal with period "${item.period}", scope "${item.scope}", a one-line headline, and the content.`,
                "If the material changes durable knowledge, add topic_updates to seal.",
            ]
            : [
                "Activity sections were recorded from transcripts without a model: read the requests, files and commits to work out what was done. Requests and replies there are short excerpts by design; do not report them as truncated or missing.",
                "Reply in exactly this format, with nothing before or after it:",
                "Headline: <one line, under 120 characters>",
                "",
                "<the note>",
            ]),
    ].join("\n");
}
function sources(atlas, item) {
    const view = new ScopeView(atlas, item.scope);
    const parts = [];
    if (item.layer === "session") {
        const s = view.sessions().find((x) => x.fm.session === item.period);
        parts.push(`## Transcript of ${link(s.path)}`, orphanText(atlas, s));
    }
    else if (item.layer === "day") {
        parts.push(...view.segmentsOn(item.period).map(renderSegmentSource));
        const human = view.humanDraftText(item.period);
        if (human)
            parts.push("## Notes a human added to the draft", human);
    }
    else {
        for (const child of view.childPeriods(item.period)) {
            const n = view.note(child);
            const label = item.layer === "year" ? child : `${weekday(child)} ${child}`;
            parts.push(`### ${link(n.path)} (${label})\nHeadline: ${n.fm.headline ?? ""}\n\n${n.body.trim()}`);
        }
        const human = view.humanDraftText(item.period);
        if (human)
            parts.push("## Notes a human added to the draft", human);
    }
    if (item.stale) {
        const amendments = /## Amendments\n([\s\S]*?)(?=\n## |$)/.exec(view.note(item.period)?.body ?? "")?.[1];
        if (amendments?.trim())
            parts.push("## Amendments made to the previous version", amendments.trim());
    }
    return parts.join("\n\n");
}
export function summarize(atlas, owner, scope, period, confirmed = false, mode = "tool") {
    const item = findItem(atlas, scope, period);
    if (item.blocked)
        throw new Error(`${period} is waiting on ${item.waitingOn.join(", ")}. Seal those first.`);
    if (item.gate === "needs_confirmation" && !confirmed) {
        const total = pending(atlas, [scope]).totalTokens;
        throw new Error(`${period} is past the cost gate (${atlas.config.costGateTokens} tokens; the pending total is about ${total}). Tell the user the estimate, ask them to confirm, then call summarize again with confirmed: true.`);
    }
    const now = atlas.now();
    if (!takeLock(atlas.paths.locksDir, lockKey(scope, period), owner, now)) {
        throw new Error(`${period} in scope "${scope}" is in progress in another session.`);
    }
    const target = lengthTarget(atlas, item.layer);
    return {
        scope,
        period,
        layer: item.layer,
        lengthTarget: target,
        estimatedTokens: item.tokens,
        instructions: writingInstructions(item, target, mode),
        sources: sources(atlas, item),
    };
}
export function seal(atlas, owner, scope, input) {
    const item = findItem(atlas, scope, input.period);
    if (item.blocked)
        throw new Error(`${input.period} is waiting on ${item.waitingOn.join(", ")}. Seal those first.`);
    const key = lockKey(scope, input.period);
    const holder = lockHolder(atlas.paths.locksDir, key, atlas.now());
    if (holder && holder !== owner)
        throw new Error(`${input.period} in scope "${scope}" is in progress in another session.`);
    const target = lengthTarget(atlas, item.layer);
    const size = tokens(input.content);
    if (size > target * 1.5) {
        throw new Error(`The content is about ${size} tokens; the target for a ${item.layer} is ${target} (limit ${Math.round(target * 1.5)}). Shorten it and call seal again.`);
    }
    const headline = atlas.scrub(input.headline.replace(/\s*\n\s*/g, " ").trim());
    const content = atlas.scrub(input.content.trim());
    const before = new Set(pending(atlas, [scope]).items.filter((i) => i.blocked).map((i) => i.period));
    const view = new ScopeView(atlas, scope);
    let path;
    let stale = [];
    if (item.layer === "session") {
        const s = view.sessions().find((x) => x.fm.session === input.period);
        const fresh = parseSession(readNote(s.path));
        const day = sessionDays(fresh)[0] ?? atlas.today();
        fresh.segments = [{ day, headline, summary: content, events: [] }];
        fresh.fm.summarized_from = "transcript";
        saveSession(fresh);
        path = s.path;
        const dayNote = view.note(day);
        if (dayNote && view.isSealed(day)) {
            writeFrontmatter(dayNote, { status: "stale" });
            stale = [day, ...markParentsStale(atlas, scope, day)];
        }
        else {
            refreshAround(atlas, scope, [day]);
        }
    }
    else {
        const old = view.note(input.period);
        const layer = parsePeriod(input.period).layer;
        const children = layer === "day" ? view.segmentsOn(input.period).map((x) => link(x.session.path)) : view.childPeriods(input.period).map((c) => link(view.note(c).path));
        let body = `# ${input.period} ${scope}\n\n${content}\n`;
        if (old && old.fm.status === "stale") {
            const previous = old.body.replace(/\n## Previous version[\s\S]*$/, "").trim();
            body += `\n## Previous version\n\nSealed ${old.fm.sealed_at ?? "earlier"}.\n\n${previous.replace(/^# .*\n+/, "")}\n`;
        }
        path = atlas.paths.periodNote(scope, input.period);
        writeNote(path, { atlas: "period", layer, period: input.period, scope, status: "sealed", headline, sources: children, sealed_at: atlas.stamp() }, body);
        if (old?.fm.status === "stale")
            stale = markParentsStale(atlas, scope, input.period);
        refreshAround(atlas, scope, [rangeOf(input.period).first]);
        writeIndex(atlas, input.period);
    }
    releaseLock(atlas.paths.locksDir, key);
    const after = pending(atlas, [scope]).items;
    const unblocked = after.filter((i) => before.has(i.period) && !i.blocked).map((i) => i.period);
    return { scope, period: input.period, path, nowStale: stale, unblocked, remaining: after.length };
}
