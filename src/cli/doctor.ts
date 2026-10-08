import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Atlas } from "../atlas.js";
import { allScopes } from "../periods.js";
import { pending } from "../rollup/index.js";
import { isOrphan, parseSession } from "../sessions/note.js";
import { listMarkdown, noteName, readNote } from "../store/note.js";

export interface DoctorReport {
  atlasDir: string;
  scopes: string[];
  notes: number;
  pending: { scope: string; count: number; tokens: number; stale: number }[];
  orphans: string[];
  openSessions: string[];
  unresolvedLinks: string[];
  staleLocks: string[];
  problems: string[];
}

const OPEN_TOO_LONG_MS = 2 * 24 * 3600 * 1000;

export function doctor(atlas: Atlas): DoctorReport {
  const root = atlas.root;
  const files = listMarkdown(join(root, "scopes")).concat(listMarkdown(join(root, "index")));
  const names = new Set(files.map(noteName));
  const problems: string[] = [];
  const links = new Set<string>();

  for (const f of files) {
    const n = readNote(f)!;
    if (n.error) problems.push(`${f.slice(root.length + 1)}: frontmatter does not parse (${n.error})`);
    if (n.fm.atlas === "topic") names.add(String(n.fm.topic));
    for (const m of n.body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) links.add(m[1]!.trim());
  }

  const now = atlas.now().getTime();
  const orphans: string[] = [];
  const openSessions: string[] = [];
  const scopes = allScopes(atlas);
  for (const scope of scopes) {
    for (const p of listMarkdown(atlas.paths.sessionsDir(scope))) {
      const note = readNote(p)!;
      if (note.error) continue;
      const s = parseSession(note);
      if (isOrphan(s)) orphans.push(noteName(p));
      const started = Date.parse(String(s.fm.started));
      if (s.fm.status === "open" && now - started > OPEN_TOO_LONG_MS) openSessions.push(noteName(p));
    }
  }

  const staleLocks: string[] = [];
  const locks = atlas.paths.locksDir;
  if (existsSync(locks)) {
    for (const f of readdirSync(locks)) {
      const at = Date.parse(JSON.parse(readFileSync(join(locks, f), "utf8")).at);
      if (now - at > 30 * 60 * 1000 || now - statSync(join(locks, f)).mtimeMs > 30 * 60 * 1000) staleLocks.push(f);
    }
  }

  return {
    atlasDir: root,
    scopes,
    notes: files.length,
    pending: scopes.map((scope) => {
      const p = pending(atlas, [scope]);
      return { scope, count: p.items.length, tokens: p.totalTokens, stale: p.items.filter((i) => i.stale).length };
    }),
    orphans,
    openSessions,
    unresolvedLinks: [...links].filter((l) => !names.has(l)).sort(),
    staleLocks,
    problems,
  };
}

export function formatDoctor(r: DoctorReport): string {
  const lines = [`Atlas: ${r.atlasDir}`, `Scopes: ${r.scopes.join(", ") || "none"}`, `Notes: ${r.notes}`, ""];
  const pend = r.pending.filter((p) => p.count);
  lines.push(pend.length ? "Pending rollups:" : "Pending rollups: none");
  for (const p of pend) lines.push(`  ${p.scope}: ${p.count} (about ${p.tokens} tokens${p.stale ? `, ${p.stale} stale` : ""})`);
  if (r.orphans.length) lines.push(`Sessions waiting to be summarized from transcripts: ${r.orphans.length}`);
  if (r.openSessions.length) lines.push(`Sessions open for more than 2 days: ${r.openSessions.join(", ")}`);
  if (r.unresolvedLinks.length) lines.push(`Links to notes that do not exist (often topics not yet written): ${r.unresolvedLinks.slice(0, 15).join(", ")}${r.unresolvedLinks.length > 15 ? ", ..." : ""}`);
  if (r.staleLocks.length) lines.push(`Expired rollup locks (safe to ignore): ${r.staleLocks.length}`);
  lines.push("", r.problems.length ? `Problems:\n${r.problems.map((p) => `  ${p}`).join("\n")}` : "No problems found.");
  return lines.join("\n");
}
