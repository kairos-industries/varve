import { tokens } from "./config.js";
import { ScopeView, weekday } from "./periods.js";
import { pending } from "./rollup/index.js";
import { isIsolated } from "./scopes/index.js";
import { hasContent, segmentHeadline } from "./sessions/note.js";
import { link, listMarkdown, noteName, readNote } from "./store/note.js";
import { topicState } from "./topics.js";
import { periodOf, previousPeriod, rangeOf } from "./time/index.js";
function topicsOf(atlas, scope) {
    return listMarkdown(atlas.paths.topicsDir(scope)).flatMap((p) => {
        const n = readNote(p);
        return n ? [{ name: String(n.fm.topic ?? noteName(p)), st: topicState(n.body) }] : [];
    });
}
const OPEN_DAYS = 14;
/**
 * What is still open in a scope: the open items of its topics, and the todos logged in the last
 * two weeks on days no rollup has read yet. Once a day is sealed, its rollup has carried the
 * todos that were still open into topics, so the raw todos stop showing.
 */
export function openLines(atlas, view, topics, today) {
    const out = [];
    const seen = new Set();
    const key = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const t of topics) {
        for (const o of t.st.open) {
            seen.add(key(o.text));
            out.push({ line: `- ${o.text} (since ${o.since}, [[${t.name}]])`, since: o.since });
        }
    }
    const from = new Date(new Date(`${today}T12:00:00Z`).getTime() - OPEN_DAYS * 86400000).toISOString().slice(0, 10);
    for (const s of view.sessions()) {
        for (const seg of s.segments) {
            if (seg.day < from || seg.day > today || view.isSealed(seg.day))
                continue;
            for (const e of seg.events.filter((x) => x.type === "todo")) {
                if (seen.has(key(e.text)))
                    continue;
                seen.add(key(e.text));
                out.push({ line: `- ${e.text} (logged ${seg.day})`, since: seg.day });
            }
        }
    }
    return out.sort((a, b) => b.since.localeCompare(a.since));
}
/** Claims that started, and claims and items that ended, on or after `from`. */
export function changedLines(topics, from) {
    const out = [];
    for (const t of topics) {
        for (const c of t.st.claims)
            if (c.since >= from)
                out.push({ line: `- [[${t.name}]]: ${c.text}`, day: c.since });
        for (const h of t.st.history) {
            if (!h.until || h.until < from)
                continue;
            const what = /resolved/.test(h.detail) ? "done" : /replaced/.test(h.detail) ? "replaced" : "no longer true";
            out.push({ line: `- [[${t.name}]]: ${what}: ${h.text}`, day: h.until });
        }
    }
    return out.sort((a, b) => b.day.localeCompare(a.day)).map((x) => x.line);
}
/** The "Open threads" part of a session summary, if the agent wrote one. */
export function openThreads(summary) {
    if (!summary)
        return undefined;
    const m = /(?:^|\n)(?:#+\s*|\*\*)Open threads(?:\*\*)?:?\s*\n([\s\S]*?)(?=\n#+\s|\n\*\*[A-Z]|$)/i.exec(summary);
    return m?.[1]?.trim() || undefined;
}
function lastClosedSession(sessions) {
    return sessions
        .filter((s) => s.fm.status === "closed" && s.segments.some(hasContent))
        .sort((a, b) => String(b.fm.ended ?? b.fm.started).localeCompare(String(a.fm.ended ?? a.fm.started)))[0];
}
function clip(text, maxTokens) {
    if (tokens(text) <= maxTokens)
        return text;
    const chars = Math.max(0, maxTokens * 4 - 60);
    return `${text.slice(0, chars).trimEnd()}\n... (cut to fit; use zoom for the rest)`;
}
function noteBody(view, period) {
    const n = view.note(period);
    if (!n)
        return "";
    return n.body
        .replace(/^# .*\n+/, "")
        .replace(/\n## Previous version[\s\S]*$/, "")
        .trim();
}
export function buildBrief(atlas, opts) {
    const { scope, compact = false } = opts;
    const lookback = Math.max(1, opts.lookback ?? 1);
    const view = new ScopeView(atlas, scope);
    const file = atlas.scopes();
    const today = atlas.today();
    const thisWeek = periodOf("week", today);
    const thisMonth = periodOf("month", today);
    const sections = [];
    const shownDays = new Set();
    const isolated = isIsolated(scope, file) ? " (isolated)" : "";
    sections.push({
        key: "header",
        title: `# Varve brief: ${scope}${isolated}`,
        body: `Today is ${weekday(today)} ${today}, week ${thisWeek}. Days end at ${atlas.config.dayBoundary} local time.`,
        priority: 0,
    });
    // Last session
    const last = lastClosedSession(view.sessions());
    if (last) {
        const seg = [...last.segments].reverse().find(hasContent);
        const threads = openThreads(seg.summary);
        const lines = [`${link(last.path)}: ${segmentHeadline(seg)}`];
        if (compact) {
            if (threads)
                lines.push("", "Open threads:", threads);
        }
        else {
            if (seg.summary)
                lines.push("", seg.summary);
            if (!seg.summary && seg.events.length)
                lines.push("", ...seg.events.slice(-10).map((e) => `- ${e.time} ${e.type}: ${e.text}`));
        }
        sections.push({ key: "last", title: `## Last session (${seg.day})`, body: lines.join("\n"), priority: 3 });
    }
    // Open, across topics and recent days
    const topics = topicsOf(atlas, scope);
    const open = openLines(atlas, view, topics, today);
    if (open.length) {
        const max = compact ? 6 : 15;
        const more = open.length > max ? `\n- (${open.length - max} more; see the topics)` : "";
        sections.push({ key: "open", title: "## Open", body: open.slice(0, max).map((o) => o.line).join("\n") + more, priority: 2 });
    }
    // What topics gained or lost this week
    const changed = changedLines(topics, rangeOf(thisWeek).first);
    if (changed.length) {
        const max = compact ? 4 : 12;
        sections.push({ key: "changed", title: "## Changed this week", body: changed.slice(0, max).join("\n") + (changed.length > max ? `\n- (${changed.length - max} more)` : ""), priority: 6 });
    }
    // Today
    const todays = view.segmentsOn(today);
    if (todays.length) {
        shownDays.add(today);
        const body = todays
            .map(({ session, segment }) => `- ${String(session.fm.started).slice(11, 16)} ${segmentHeadline(segment)}${session.fm.status === "open" ? " (in progress)" : ""}`)
            .join("\n");
        sections.push({ key: "today", title: `## Today (draft)`, body, priority: 4 });
    }
    // Last worked days
    const earlier = view.workedDays().filter((d) => d < today).reverse().slice(0, lookback);
    earlier.forEach((day, i) => {
        shownDays.add(day);
        let body;
        if (view.isSealed(day)) {
            body = compact ? `${view.headline(day)}` : `**${view.headline(day)}**\n\n${noteBody(view, day)}`;
        }
        else {
            body = view
                .segmentsOn(day)
                .map(({ segment }) => (compact || !segment.summary ? `- ${segmentHeadline(segment)}` : `- **${segmentHeadline(segment)}**\n${segment.summary.replace(/^/gm, "  ")}`))
                .join("\n");
        }
        sections.push({ key: `day${i}`, title: `## Last worked day: ${weekday(day)} ${day}${view.isSealed(day) ? "" : " (not yet summarized)"}`, body, priority: 5 + i });
    });
    // This week: sealed days not shown above
    const weekDays = view.workedDaysIn(thisWeek).filter((d) => !shownDays.has(d) && view.isSealed(d));
    if (weekDays.length) {
        weekDays.forEach((d) => shownDays.add(d));
        sections.push({
            key: "week",
            title: `## This week (${thisWeek}, draft)`,
            body: weekDays.map((d) => `- ${weekday(d)} ${d.slice(5)}: ${view.headline(d)}`).join("\n"),
            priority: 6,
        });
    }
    if (!compact) {
        // Previous weeks
        let week = previousPeriod(thisWeek);
        for (let i = 0; i < lookback; i++, week = previousPeriod(week)) {
            if (!view.workedDaysIn(week).length)
                continue;
            const body = view.isSealed(week)
                ? `**${view.headline(week)}**\n\n${noteBody(view, week)}`
                : view.workedDaysIn(week).map((d) => `- ${weekday(d)} ${d.slice(5)}: ${view.headline(d)}`).join("\n");
            sections.push({ key: `pweek${i}`, title: `## Week ${week}${view.isSealed(week) ? "" : " (not yet summarized)"}`, body, priority: 8 + i });
        }
        // This month: sealed days before this week
        const weekStart = rangeOf(thisWeek).first;
        const monthDays = view.workedDaysIn(thisMonth).filter((d) => d < weekStart && !shownDays.has(d) && view.isSealed(d));
        if (monthDays.length) {
            sections.push({
                key: "month",
                title: `## This month (${thisMonth}, draft)`,
                body: monthDays.map((d) => `- ${d.slice(5)}: ${view.headline(d)}`).join("\n"),
                priority: 9,
            });
        }
        // Previous months
        let month = previousPeriod(thisMonth);
        for (let i = 0; i < lookback; i++, month = previousPeriod(month)) {
            if (!view.workedDaysIn(month).length)
                continue;
            const body = view.isSealed(month)
                ? `**${view.headline(month)}**\n\n${noteBody(view, month)}`
                : view.workedDaysIn(month).filter((d) => view.isSealed(d)).map((d) => `- ${d.slice(5)}: ${view.headline(d)}`).join("\n") || "(days not yet summarized)";
            sections.push({ key: `pmonth${i}`, title: `## Month ${month}${view.isSealed(month) ? "" : " (not yet summarized)"}`, body, priority: 10 + i });
        }
        // Year, once it has a sealed month
        const year = today.slice(0, 4);
        const sealedMonths = view.workedPeriods("month").filter((m) => m.startsWith(year) && view.isSealed(m));
        if (sealedMonths.length) {
            sections.push({
                key: "year",
                title: `## This year: ${year}`,
                body: sealedMonths.map((m) => `- ${m}: ${view.headline(m)}`).join("\n"),
                priority: 11,
            });
        }
        const prevYear = String(Number(year) - 1);
        if (view.isSealed(prevYear)) {
            sections.push({ key: "pyear", title: `## Year ${prevYear}`, body: `**${view.headline(prevYear)}**\n\n${noteBody(view, prevYear)}`, priority: 12 });
        }
    }
    // Elsewhere this week
    const others = opts.visible.filter((s) => s !== scope && !isIsolated(s, file) && !isIsolated(scope, file));
    const elsewhere = [];
    for (const other of others) {
        const ov = new ScopeView(atlas, other);
        const headline = ov.workedDaysIn(thisWeek).length ? ov.headline(thisWeek) : "";
        if (headline)
            elsewhere.push(`- **${other}**: ${headline}`);
    }
    if (elsewhere.length) {
        sections.push({ key: "elsewhere", title: "## Elsewhere this week", body: elsewhere.slice(0, compact ? 5 : 20).join("\n"), priority: 7 });
    }
    // Pending rollups
    const p = pending(atlas, [scope]);
    if (p.items.length) {
        const n = p.items.length;
        const gate = p.totalTokens > p.gateTokens ? `over the ${p.gateTokens} gate, so ask the user first` : `under the ${p.gateTokens} gate`;
        const list = `${p.items
            .slice(0, 6)
            .map((i) => i.period)
            .join(", ")}${n > 6 ? ", ..." : ""}`;
        sections.push({
            key: "pending",
            title: "## Pending rollups",
            body: atlas.config.rollups === "nightly"
                ? `${n} rollup${n === 1 ? "" : "s"} pending (${list}). The nightly run writes them; do them now only if the user asks.`
                : `${n} rollup${n === 1 ? "" : "s"} pending (about ${p.totalTokens} tokens, ${gate}): ${list}. Call pending() and work through them.`,
            priority: 1,
        });
    }
    return fit(sections, opts.capTokens);
}
/** Keep sections by priority within the cap, clipping the first one that does not fit. */
function fit(sections, cap) {
    const byPriority = [...sections].sort((a, b) => a.priority - b.priority);
    const allowed = new Map();
    let used = 0;
    for (const s of byPriority) {
        const cost = tokens(`${s.title}\n${s.body}\n\n`);
        const room = cap - used;
        if (cost <= room) {
            allowed.set(s.key, s.body);
            used += cost;
        }
        else if (room > 80) {
            const body = clip(s.body, room - tokens(s.title) - 10);
            allowed.set(s.key, body);
            used += tokens(`${s.title}\n${body}\n\n`);
        }
    }
    return sections
        .filter((s) => allowed.has(s.key))
        .map((s) => `${s.title}\n${allowed.get(s.key)}`.trimEnd())
        .join("\n\n")
        .concat("\n");
}
