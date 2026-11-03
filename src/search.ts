import MiniSearch from "minisearch";
import { statSync } from "node:fs";
import type { Atlas } from "./atlas.js";
import { cosine, type Embedder, embedder as installedEmbedder } from "./embed/index.js";
import { isHumanEdited, listMarkdown, noteName, readNote } from "./store/note.js";
import { rangeOf } from "./time/index.js";

export interface SearchInput {
  query: string;
  scopes: string[];
  layer?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** keyword: BM25 only. semantic: embeddings only. hybrid: both, fused by rank. */
export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface SearchOptions {
  mode?: SearchMode;
  /** Defaults to the installed model; tests and the benchmark pass their own. */
  embedder?: Embedder;
  /** Defaults to MIN_SIMILARITY; the benchmark sweeps it. */
  minSimilarity?: number;
}

export interface SearchResult {
  note: string;
  scope: string;
  layer: string;
  period: string;
  score: number;
  /** keyword, meaning, or both. */
  match: "keyword" | "meaning" | "both";
  snippet: string;
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
    // A draft is assembled from the notes beneath it, so it would only repeat their matches
    // above them. Sealed summaries and drafts a person wrote in are searched.
    if (fm.status === "draft" && !fm.human_edited && !isHumanEdited(note)) return undefined;
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

const CHUNK_WORDS = 60;

/**
 * Pieces of a note to embed one by one: paragraphs and list items, merged up to about 60 words.
 * A whole note averaged into one vector says little; a note matches by its best piece.
 */
export function chunks(text: string): string[] {
  const pieces = text
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.|#+)\s)/)
    .map((p) => p.replace(/^#+\s+/gm, "").replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) => alias ?? target).trim())
    .filter((p) => /\w/.test(p) && !/^---$/.test(p));
  const out: string[] = [];
  let current = "";
  for (const p of pieces) {
    const words = (s: string) => s.split(/\s+/).length;
    if (current && words(current) + words(p) > CHUNK_WORDS) {
      out.push(current);
      current = p;
    } else current = current ? `${current}\n${p}` : p;
  }
  if (current) out.push(current);
  return out;
}

interface Embedded {
  key: string;
  pieces: { text: string; v: Float32Array }[];
}

/** Embeddings per note, kept for the life of the process and redone when the file changes. */
const cache = new Map<string, Embedded>();

function embedded(doc: Doc, model: Embedder): Embedded {
  let key = "";
  try {
    const st = statSync(doc.id);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    // a note deleted since it was read; embed what was read
  }
  const hit = cache.get(doc.id);
  if (hit && key && hit.key === key) return hit;
  const pieces = chunks(doc.text).flatMap((text) => {
    const v = model.embed(text);
    return v ? [{ text, v }] : [];
  });
  const out = { key, pieces };
  if (key) cache.set(doc.id, out);
  return out;
}

/** Below this cosine similarity a piece is not taken as a match by meaning. */
export const MIN_SIMILARITY = 0.35;
const RRF_K = 60;
const SEMANTIC_DEPTH = 50;

/** Search across the notes of the given scopes. Keyword (BM25), and by meaning when the embedding model is installed. */
export function search(atlas: Atlas, input: SearchInput, opts: SearchOptions = {}): SearchResult[] {
  const model = opts.embedder ?? (atlas.config.semanticSearch && opts.mode !== "keyword" ? installedEmbedder() : undefined);
  const mode: SearchMode = opts.mode ?? (model ? "hybrid" : "keyword");
  if (mode !== "keyword" && !model) throw new Error("Search by meaning needs the embedding model. Run `temporal-atlas models pull`.");
  const keep = (d: { layer: string; first: string; last: string }) =>
    (!input.layer || d.layer === input.layer) && (!input.from || d.last >= input.from) && (!input.to || d.first <= input.to);
  const docs = input.scopes.flatMap((s) => listMarkdown(atlas.paths.scopeDir(s)).map(toDoc)).filter((d): d is Doc => Boolean(d) && keep(d!));
  const byId = new Map(docs.map((d) => [d.id, d]));
  const fused = new Map<string, { score: number; keyword?: string[]; meaning?: string }>();
  const add = (id: string, rank: number) => {
    const e = fused.get(id) ?? { score: 0 };
    e.score += 1 / (RRF_K + rank);
    fused.set(id, e);
    return e;
  };

  if (mode !== "semantic") {
    const index = new MiniSearch<Doc>({
      fields: ["text", "name"],
      storeFields: [],
      searchOptions: { prefix: true, fuzzy: 0.15, boost: { name: 2 } },
    });
    index.addAll(docs);
    index.search(input.query).forEach((r, rank) => {
      add(String(r.id), rank).keyword = r.terms;
    });
  }

  if (mode !== "keyword") {
    const q = model!.embed(input.query);
    if (q) {
      docs
        .map((d) => {
          let best = { sim: -1, text: "" };
          for (const p of embedded(d, model!).pieces) {
            const sim = cosine(q, p.v);
            if (sim > best.sim) best = { sim, text: p.text };
          }
          return { id: d.id, ...best };
        })
        .filter((r) => r.sim >= (opts.minSimilarity ?? MIN_SIMILARITY))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, SEMANTIC_DEPTH)
        .forEach((r, rank) => {
          add(r.id, rank).meaning = r.text;
        });
    }
  }

  // Ties go to the note name, so the same files always give the same order.
  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score || byId.get(a[0])!.name.localeCompare(byId.get(b[0])!.name))
    .slice(0, input.limit ?? 10)
    .map(([id, e]) => {
      const d = byId.get(id)!;
      const match = e.keyword && e.meaning ? "both" : e.keyword ? "keyword" : "meaning";
      const text = e.keyword ? snippet(d.text, e.keyword) : (e.meaning ?? "").replace(/\s+/g, " ").slice(0, 300);
      return { note: d.name, scope: d.scope, layer: d.layer, period: d.period, score: Math.round(e.score * 6000) / 100, match, snippet: text };
    });
}
