import MiniSearch from "minisearch";
import { listMarkdown, noteName, readNote } from "./store/note.js";
import { rangeOf } from "./time/index.js";
function toDoc(path) {
    const note = readNote(path);
    if (!note)
        return undefined;
    const fm = note.fm;
    const scope = String(fm.scope ?? "");
    let layer;
    let period = "";
    let first = "";
    let last = "";
    if (fm.atlas === "session") {
        layer = "session";
        const days = Array.isArray(fm.days) ? fm.days : [];
        period = String(fm.session ?? noteName(path));
        first = days[0] ?? String(fm.started ?? "").slice(0, 10);
        last = days.at(-1) ?? first;
    }
    else if (fm.atlas === "period") {
        layer = String(fm.layer);
        period = String(fm.period);
        ({ first, last } = rangeOf(period));
    }
    else if (fm.atlas === "topic") {
        layer = "topic";
        period = String(fm.topic ?? noteName(path));
        first = String(fm.created ?? "").slice(0, 10);
        last = String(fm.updated ?? fm.created ?? "").slice(0, 10);
    }
    else {
        return undefined;
    }
    return { id: path, name: noteName(path), scope, layer, period, first, last, text: `${fm.headline ?? ""}\n${note.body}` };
}
function snippet(text, terms) {
    const lower = text.toLowerCase();
    const hit = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, hit - 100);
    const out = text.slice(start, hit + 200).replace(/\s+/g, " ").trim();
    return `${start > 0 ? "..." : ""}${out}${hit + 200 < text.length ? "..." : ""}`;
}
/** Keyword search across the notes of the given scopes. The index is rebuilt from the files on each call. */
export function search(atlas, input) {
    const docs = input.scopes.flatMap((s) => listMarkdown(atlas.paths.scopeDir(s)).map(toDoc)).filter((d) => Boolean(d));
    const index = new MiniSearch({
        fields: ["text", "name"],
        storeFields: ["name", "scope", "layer", "period", "first", "last", "text"],
        searchOptions: { prefix: true, fuzzy: 0.15, boost: { name: 2 } },
    });
    index.addAll(docs);
    return index
        .search(input.query, {
        filter: (r) => (!input.layer || r.layer === input.layer) &&
            (!input.from || r.last >= input.from) &&
            (!input.to || r.first <= input.to),
    })
        .slice(0, input.limit ?? 10)
        .map((r) => ({
        note: r.name,
        scope: r.scope,
        layer: r.layer,
        period: r.period,
        score: Math.round(r.score * 100) / 100,
        snippet: snippet(r.text, r.terms),
    }));
}
