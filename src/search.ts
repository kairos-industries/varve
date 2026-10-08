import MiniSearch from "minisearch";
import type { Atlas } from "./atlas.js";
import { listMarkdown, noteName, readNote } from "./store/note.js";
import { rangeOf } from "./time/index.js";

export interface SearchInput {
  query: string;
  scopes: string[];
  layer?: string;
  from?: string;
  to?: string;
  limit?: number;
}

interface Doc {
  id: string;
  name: string;
  scope: string;
  layer: string;
  period: string;
  first: string;
  last: string;
  text: string;
}

function toDoc(path: string): Doc | undefined {
  const note = readNote(path);
  if (!note) return undefined;
  const fm = note.fm;
  const scope = String(fm.scope ?? "");
  let layer: string;
  let period = "";
  let first = "";
  let last = "";
  if (fm.atlas === "session") {
    layer = "session";
    const days = Array.isArray(fm.days) ? (fm.days as string[]) : [];
    period = String(fm.session ?? noteName(path));
    first = days[0] ?? String(fm.started ?? "").slice(0, 10);
    last = days.at(-1) ?? first;
  } else if (fm.atlas === "period") {
    layer = String(fm.layer);
    period = String(fm.period);
    ({ first, last } = rangeOf(period));
  } else if (fm.atlas === "topic") {
    layer = "topic";
    period = String(fm.topic ?? noteName(path));
    first = String(fm.created ?? "").slice(0, 10);
    last = String(fm.updated ?? fm.created ?? "").slice(0, 10);
  } else {
    return undefined;
  }
  return { id: path, name: noteName(path), scope, layer, period, first, last, text: `${fm.headline ?? ""}\n${note.body}` };
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const hit = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 100);
  const out = text.slice(start, hit + 200).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${out}${hit + 200 < text.length ? "..." : ""}`;
}

/** Keyword search across the notes of the given scopes. The index is rebuilt from the files on each call. */
export function search(atlas: Atlas, input: SearchInput) {
  const docs = input.scopes.flatMap((s) => listMarkdown(atlas.paths.scopeDir(s)).map(toDoc)).filter((d): d is Doc => Boolean(d));
  const index = new MiniSearch<Doc>({
    fields: ["text", "name"],
    storeFields: ["name", "scope", "layer", "period", "first", "last", "text"],
    searchOptions: { prefix: true, fuzzy: 0.15, boost: { name: 2 } },
  });
  index.addAll(docs);
  return index
    .search(input.query, {
      filter: (r) =>
        (!input.layer || r.layer === input.layer) &&
        (!input.from || (r.last as string) >= input.from) &&
        (!input.to || (r.first as string) <= input.to),
    })
    .slice(0, input.limit ?? 10)
    .map((r) => ({
      note: r.name as string,
      scope: r.scope as string,
      layer: r.layer as string,
      period: r.period as string,
      score: Math.round(r.score * 100) / 100,
      snippet: snippet(r.text as string, r.terms),
    }));
}
