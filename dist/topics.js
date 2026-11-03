import { cleanText, lineId, parseClaim, parseHistory, parseOpen, renderClaim, renderHistory, renderOpen } from "./claims.js";
import { tokens } from "./config.js";
import { GENERAL } from "./scopes/index.js";
import { rangeOf } from "./time/index.js";
import { link, listMarkdown, noteName, readNote, writeNote } from "./store/note.js";
const NOW = "What we know now";
/** The claims, open items and history of a topic note body. */
export function topicState(body) {
    const lines = (title) => (section(body, title) ?? "").split("\n").filter((l) => l.trim());
    const st = { prose: [], claims: [], open: [], history: [], otherOpen: [], otherHistory: [] };
    for (const l of lines(NOW)) {
        const c = parseClaim(l);
        if (c)
            st.claims.push(c);
        else if (l.trim() !== "_Not yet written._")
            st.prose.push(l);
    }
    for (const l of lines("Open")) {
        const o = parseOpen(l);
        if (o)
            st.open.push(o);
        else
            st.otherOpen.push(l);
    }
    for (const l of lines("History")) {
        const h = parseHistory(l);
        if (h)
            st.history.push(h);
        else
            st.otherHistory.push(l);
    }
    return st;
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Apply claim operations to a topic's state, or throw before changing anything. */
function applyClaims(atlas, name, st, u, ctx) {
    const changes = [];
    const taken = new Set([...st.claims, ...st.open, ...st.history].map((x) => x.id));
    const day = (d) => {
        const v = d ?? ctx.day;
        if (!DAY.test(v))
            throw new Error(`"${v}" is not a day (YYYY-MM-DD).`);
        if ((ctx.first && v < ctx.first) || (ctx.last && v > ctx.last))
            throw new Error(`${v} is outside the period being written (${ctx.first} to ${ctx.last}).`);
        if (v > atlas.today())
            throw new Error(`${v} is in the future.`);
        return v;
    };
    const current = (id, what) => {
        const c = st.claims.find((x) => x.id === id.replace(/^\^/, ""));
        if (!c)
            throw new Error(`Topic "${name}" has no current claim ^${id.replace(/^\^/, "")} to ${what}. Current claims: ${st.claims.map((x) => `^${x.id}`).join(", ") || "none"}.`);
        return c;
    };
    const openItem = (id) => {
        const o = st.open.find((x) => x.id === id.replace(/^\^/, ""));
        if (!o)
            throw new Error(`Topic "${name}" has no open item ^${id.replace(/^\^/, "")}. Open items: ${st.open.map((x) => `^${x.id}`).join(", ") || "none"}.`);
        return o;
    };
    // Check everything first, so a bad id or day rejects the whole update.
    const plan = {
        claims: (u.claims ?? []).map((c) => ({ text: atlas.scrub(cleanText(c.text)), since: day(c.since), replaces: c.replaces ? current(c.replaces, "replace") : undefined })),
        close: (u.close ?? []).map((id) => current(id, "close")),
        open: (u.open ?? []).map((o) => (typeof o === "string" ? { text: o } : o)).map((o) => ({ text: atlas.scrub(cleanText(o.text)), since: day(o.since) })),
        resolve: (u.resolve ?? []).map((r) => ({ item: openItem(r.id), how: r.how ? atlas.scrub(cleanText(r.how)) : undefined })),
    };
    const retire = (c, detail) => {
        st.claims = st.claims.filter((x) => x.id !== c.id);
        st.history.push({ id: c.id, text: c.text, detail });
    };
    for (const c of plan.claims) {
        if (st.claims.some((x) => x.text === c.text))
            continue;
        const id = lineId("c", name, c.text, c.since, taken);
        taken.add(id);
        if (c.replaces) {
            retire(c.replaces, `since ${c.replaces.since}, until ${c.since}, replaced by ^${id}`);
            changes.push(`replaced ^${c.replaces.id} with ^${id}`);
        }
        else
            changes.push(`claim ^${id}`);
        st.claims.push({ id, text: c.text, since: c.since, source: ctx.source });
    }
    for (const c of plan.close) {
        if (!st.claims.includes(c))
            continue;
        retire(c, `since ${c.since}, until ${ctx.day}`);
        changes.push(`closed ^${c.id}`);
    }
    for (const o of plan.open) {
        if (st.open.some((x) => x.text === o.text))
            continue;
        const id = lineId("o", name, o.text, o.since, taken);
        taken.add(id);
        st.open.push({ id, text: o.text, since: o.since, source: ctx.source });
        changes.push(`open ^${id}`);
    }
    for (const r of plan.resolve) {
        if (!st.open.includes(r.item))
            continue;
        st.open = st.open.filter((x) => x !== r.item);
        st.history.push({ id: r.item.id, text: r.item.text, detail: `open ${r.item.since}, resolved ${ctx.day}${r.how ? `: ${r.how}` : ""}` });
        changes.push(`resolved ^${r.item.id}`);
    }
    return changes;
}
function renderState(body, st) {
    const now = [...st.prose, ...st.claims.map(renderClaim)];
    body = replaceSection(body, NOW, now.length ? now.join("\n") : "_Not yet written._");
    const open = [...st.open.map(renderOpen), ...st.otherOpen];
    const history = [...st.history.map(renderHistory), ...st.otherHistory];
    // Open and History sit between "What we know now" and the Timeline; they appear once they have lines.
    if (open.length || section(body, "Open") !== undefined)
        body = placeSection(body, "Open", open.join("\n") || "_Nothing open._");
    if (history.length || section(body, "History") !== undefined)
        body = placeSection(body, "History", history.join("\n"));
    return body;
}
/** Set a section's content, adding the section just before the Timeline when it is missing. */
function placeSection(body, title, content) {
    if (section(body, title) !== undefined)
        return replaceSection(body, title, content);
    const at = body.search(/\n## Timeline\n/);
    if (at < 0)
        return replaceSection(body, title, content);
    return `${body.slice(0, at).trimEnd()}\n\n## ${title}\n\n${content}\n${body.slice(at)}`;
}
const STOP = new Set(["the", "a", "an", "of", "and", "for", "to", "in", "on", "with"]);
function words(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((w) => w && !STOP.has(w))
        .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}
function sameWord(a, b) {
    if (a === b)
        return true;
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    return short.length >= 4 && long.startsWith(short);
}
function editRatio(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m || !n)
        return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++)
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
}
/** Whether two topic names probably mean the same subject. */
export function similarNames(a, b) {
    const wa = words(a);
    const wb = words(b);
    if (!wa.length || !wb.length)
        return false;
    const shared = wa.filter((x) => wb.some((y) => sameWord(x, y))).length;
    const overlap = shared / Math.max(wa.length, wb.length);
    return overlap >= 0.5 || editRatio(wa.join(" "), wb.join(" ")) >= 0.8;
}
export function topicNames(atlas, scope) {
    return listMarkdown(atlas.paths.topicsDir(scope)).map((p) => String(readNote(p)?.fm.topic ?? noteName(p)));
}
function findTopic(atlas, scope, name) {
    const want = name.trim().toLowerCase();
    return listMarkdown(atlas.paths.topicsDir(scope)).find((p) => String(readNote(p)?.fm.topic ?? noteName(p)).toLowerCase() === want);
}
function section(body, title) {
    const m = new RegExp(`(?:^|\\n)## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body);
    return m ? m[1].trim() : undefined;
}
function replaceSection(body, title, content) {
    const re = new RegExp(`((?:^|\\n)## ${title}\\n)([\\s\\S]*?)(?=\\n## |$)`);
    if (re.test(body))
        return body.replace(re, (_m, head) => `${head}\n${content}\n`);
    return `${body.trimEnd()}\n\n## ${title}\n\n${content}\n`;
}
/**
 * Read, create or update a topic. `scopes` is the lookup order for reads (the session's
 * scope, then general); writes go to the first of them.
 */
export function topic(atlas, scopes, input) {
    const name = input.name.trim().replace(/\s+/g, " ");
    const home = scopes[0];
    let path;
    let scope = home;
    for (const s of scopes) {
        path = findTopic(atlas, s, name);
        if (path) {
            scope = s;
            break;
        }
    }
    if (!input.update) {
        if (!path) {
            const similar = scopes.flatMap((s) => topicNames(atlas, s)).filter((n) => similarNames(n, name));
            return { name, scope: home, exists: false, similar };
        }
        return { name, scope, exists: true, path, content: readNote(path).body.trim() };
    }
    const state = input.update.state ? atlas.scrub(input.update.state.trim()) : undefined;
    const entry = input.update.entry
        ? `- ${atlas.today()} ${atlas.scrub(input.update.entry.replace(/\s*\n\s*/g, " ").trim())}${input.source ? ` ${input.source}` : ""}`
        : undefined;
    let created = false;
    if (!path) {
        const similar = topicNames(atlas, home).filter((n) => similarNames(n, name));
        if (similar.length && !input.force) {
            return { name, scope: home, exists: false, created: false, similar };
        }
        path = atlas.paths.topicNote(home, name);
        scope = home;
        created = true;
    }
    const existing = readNote(path);
    let body = existing?.body ?? `# ${name}\n\n## What we know now\n\n_Not yet written._\n\n## Timeline\n`;
    const st = topicState(body);
    const changes = applyClaims(atlas, name, st, input.update, { day: atlas.today(), ...input.context, source: input.source });
    if (state)
        st.prose = state.split("\n");
    if (state || changes.length)
        body = renderState(body, st);
    if (entry) {
        const timeline = section(body, "Timeline");
        body = replaceSection(body, "Timeline", timeline ? `${timeline}\n${entry}` : entry);
    }
    const stamp = atlas.stamp();
    writeNote(path, { atlas: "topic", scope, topic: name, created: existing?.fm.created ?? stamp, updated: stamp }, body);
    return { name, scope, exists: true, created, path, content: body.trim(), changes };
}
/**
 * Check claim operations against a topic without writing, so a rollup can be refused before it is
 * sealed. Unknown topics pass: they are created on apply.
 */
export function checkTopicUpdate(atlas, scope, name, update, context) {
    const path = findTopic(atlas, scope, name.trim().replace(/\s+/g, " "));
    const st = topicState(path ? readNote(path).body : "");
    applyClaims(atlas, name, st, update, context);
}
export function topicScopes(scope) {
    return scope === GENERAL ? [GENERAL] : [scope, GENERAL];
}
export { link };
/**
 * The days a rollup's claims may name: within the period, and not after today. A claim's day
 * defaults to the period's last day: by then it was true. An orphan session has no period, so
 * its claims are dated today.
 */
export function rollupContext(atlas, period) {
    const today = atlas.today();
    try {
        const { first, last } = rangeOf(period);
        const end = last < today ? last : today;
        return { first, last: end, day: end };
    }
    catch {
        return { day: today };
    }
}
/** Refuse a rollup's topic updates before anything is sealed: unknown ids, days outside the period, empty text. */
export function checkRollupTopics(atlas, scope, period, updates) {
    for (const u of updates) {
        try {
            checkTopicUpdate(atlas, scope, u.name, u, rollupContext(atlas, period));
        }
        catch (e) {
            throw new Error(`topic_updates for "${u.name}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
/** Apply a sealed rollup's topic updates, each line citing the rollup's note. */
export function applyRollupTopics(atlas, scope, period, source, updates) {
    return updates.map((u) => {
        const { name, ...update } = u;
        return topic(atlas, [scope], { name, update, force: true, source, context: rollupContext(atlas, period) });
    });
}
/**
 * The current claims and open items of a scope's topics, with their ids, for the writer of a
 * rollup. History is left out: it cannot change.
 */
export function topicDigest(atlas, scope, maxTokens = 1500) {
    const blocks = [];
    for (const p of listMarkdown(atlas.paths.topicsDir(scope))) {
        const n = readNote(p);
        if (!n)
            continue;
        const st = topicState(n.body);
        const lines = [...st.claims.map((c) => `- ^${c.id} ${c.text} (since ${c.since})`), ...st.open.map((o) => `- open ^${o.id} ${o.text} (since ${o.since})`)];
        blocks.push(`### ${String(n.fm.topic ?? noteName(p))}\n${lines.join("\n") || "- (no claims yet)"}`);
    }
    let out = "";
    for (const b of blocks) {
        if (tokens(out + b) > maxTokens) {
            out += `\n(${blocks.length - out.split("### ").length + 1} more topics not shown)`;
            break;
        }
        out += `${out ? "\n\n" : ""}${b}`;
    }
    return out;
}
