import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";

export type Frontmatter = Record<string, unknown>;

export interface Note {
  path: string;
  fm: Frontmatter;
  body: string;
}

export function hashBody(body: string): string {
  return createHash("sha256").update(body.trim()).digest("hex").slice(0, 16);
}

const FM_RE = /^---\n([\s\S]*?)\n---\n?/;

export function parseNote(path: string, text: string): Note {
  const m = FM_RE.exec(text);
  if (!m) return { path, fm: {}, body: text };
  const fm = (parse(m[1] ?? "") as Frontmatter | null) ?? {};
  return { path, fm, body: text.slice(m[0].length) };
}

export function readNote(path: string): Note | undefined {
  if (!existsSync(path)) return undefined;
  return parseNote(path, readFileSync(path, "utf8"));
}

/** True when the body no longer matches the hash the server stored when it last wrote the note. */
export function isHumanEdited(note: Note): boolean {
  const stored = note.fm.atlas_hash;
  return typeof stored === "string" && stored !== hashBody(note.body);
}

function clean(fm: Frontmatter): Frontmatter {
  return Object.fromEntries(Object.entries(fm).filter(([, v]) => v !== undefined));
}

/** Write a note atomically, stamping `atlas_hash` with the hash of its body. */
export function writeNote(path: string, fm: Frontmatter, body: string): Note {
  const text = body.endsWith("\n") ? body : `${body}\n`;
  const full = { ...clean(fm), atlas_hash: hashBody(text) };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, `---\n${stringify(full, { lineWidth: 0 }).trimEnd()}\n---\n${text}`);
  renameSync(tmp, path);
  return { path, fm: full, body: text };
}

/** Rewrite only the frontmatter, keeping the body and its stored hash as they are. */
export function writeFrontmatter(note: Note, changes: Frontmatter): Note {
  const fm = clean({ ...note.fm, ...changes });
  mkdirSync(dirname(note.path), { recursive: true });
  writeFileSync(note.path, `---\n${stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n${note.body}`);
  return { ...note, fm };
}

export function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listMarkdown(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

export function noteName(path: string): string {
  return basename(path, ".md");
}

export function link(path: string, label?: string): string {
  const name = noteName(path);
  return label && label !== name ? `[[${name}|${label}]]` : `[[${name}]]`;
}
