import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { markParentsStale, refreshAround, ScopeView, writeIndex } from "../periods.js";
import { isHumanEdited, listMarkdown, readNote, writeFrontmatter, writeNote } from "../store/note.js";
import { parsePeriod } from "../time/index.js";
import { topic } from "../topics.js";
import { slug, writeScopes } from "./index.js";
/** Rewrite every index note, after visibility or scope names change. */
export function rebuildIndexes(atlas) {
    for (const p of listMarkdown(`${atlas.root}/index`)) {
        const period = readNote(p)?.fm.period;
        if (typeof period === "string")
            writeIndex(atlas, period);
    }
}
/** Move everything in scope `from` into scope `to`. Overlapping sealed notes in `to` become stale. */
export function mergeScope(atlas, from, to) {
    if (from === to)
        throw new Error("A scope cannot be merged into itself.");
    const fromDir = atlas.paths.scopeDir(from);
    if (!existsSync(fromDir))
        throw new Error(`Scope "${from}" has no notes.`);
    const target = new ScopeView(atlas, to);
    const touchedDays = new Set();
    const origins = new Map();
    const movedPeriods = [];
    for (const path of listMarkdown(fromDir)) {
        const note = readNote(path);
        if (note.fm.atlas === "session") {
            writeNote(path.replace(fromDir, atlas.paths.scopeDir(to)), { ...note.fm, scope: to }, note.body);
            if (typeof note.fm.origin === "string")
                origins.set(note.fm.origin, note.fm.origin_kind === "remote" ? "remote" : "path");
            for (const d of Array.isArray(note.fm.days) ? note.fm.days : [])
                touchedDays.add(d);
        }
        else if (note.fm.atlas === "period") {
            const period = String(note.fm.period);
            const existing = target.note(period);
            if (!existing) {
                const sealed = note.fm.status === "sealed" || note.fm.status === "stale";
                if (sealed) {
                    writeNote(atlas.paths.periodNote(to, period), { ...note.fm, scope: to }, note.body.replace(`# ${period} ${from}`, `# ${period} ${to}`));
                    movedPeriods.push(period);
                }
            }
            else if (existing.fm.status === "sealed") {
                writeFrontmatter(existing, { status: "stale" });
                markParentsStale(atlas, to, period);
            }
        }
        else if (note.fm.atlas === "topic") {
            const name = String(note.fm.topic);
            topic(atlas, [to], { name, update: { entry: `Merged from scope ${from}:\n${note.body.trim()}` }, force: true });
        }
    }
    rmSync(fromDir, { recursive: true, force: true });
    // Days that now hold sessions from both scopes need a fresh rollup.
    for (const day of touchedDays) {
        const n = target.note(day);
        if (n?.fm.status === "sealed" && !movedPeriods.includes(day)) {
            writeFrontmatter(n, { status: "stale" });
            markParentsStale(atlas, to, day);
        }
    }
    const file = atlas.scopes();
    file.rules = file.rules.map((r) => (r.scope === from ? { ...r, scope: to } : r));
    // Only folders that went to `from` by their own name need a rule. A session moved into `from`
    // by hand keeps its folder's own scope; mapping that folder would send all its future work to `to`.
    for (const [match, kind] of origins) {
        if (naturalScope(match, kind) !== from)
            continue;
        if (!file.rules.some((r) => r.kind === kind && r.match === match))
            file.rules.push({ kind, match, scope: to });
    }
    const info = file.scopes[from];
    delete file.scopes[from];
    if (info?.isolated)
        file.scopes[to] = { ...file.scopes[to], isolated: true };
    writeScopes(atlas.paths.scopesFile, file);
    refreshAround(atlas, to, [...touchedDays].filter((d) => parsePeriod(d).layer === "day"));
    rebuildIndexes(atlas);
    relinkPeriods(atlas, from, to);
}
/** The scope a session's folder or remote gets when no rule applies, as in `detectScope`. */
function naturalScope(match, kind) {
    return slug(kind === "remote" ? (match.split("/").pop() ?? "") : basename(match));
}
/**
 * Point links to `from`'s period notes (`[[2026-10-08 from]]`, with or without an alias or heading)
 * at the same notes in `to`, in bodies and frontmatter across the atlas. A note the server wrote
 * gets a fresh hash, since this is the server's change; a note a person edited keeps its old hash,
 * so it still counts as edited.
 */
function relinkPeriods(atlas, from, to) {
    const name = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\[\\[(\\d{4}(?:-W\\d{2}|-\\d{2}(?:-\\d{2})?)?) ${name}((?:[#|][^\\]]*)?)\\]\\]`, "g");
    const swap = (s) => s.replace(re, `[[$1 ${to}$2]]`);
    const deep = (v) => typeof v === "string" ? swap(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
    for (const path of listMarkdown(atlas.root)) {
        const note = readNote(path);
        if (!note || note.error)
            continue;
        const body = swap(note.body);
        const fm = deep(note.fm);
        if (body === note.body && JSON.stringify(fm) === JSON.stringify(note.fm))
            continue;
        if (typeof note.fm.atlas_hash === "string" && !isHumanEdited(note))
            writeNote(path, fm, body);
        else
            writeFrontmatter({ ...note, body }, fm);
    }
}
