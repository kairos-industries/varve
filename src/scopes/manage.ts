import { existsSync, rmSync } from "node:fs";
import type { Atlas } from "../atlas.js";
import { markParentsStale, refreshAround, ScopeView, writeIndex } from "../periods.js";
import { listMarkdown, readNote, writeFrontmatter, writeNote } from "../store/note.js";
import { parsePeriod } from "../time/index.js";
import { topic } from "../topics.js";
import { writeScopes } from "./index.js";

/** Rewrite every index note, after visibility or scope names change. */
export function rebuildIndexes(atlas: Atlas) {
  for (const p of listMarkdown(`${atlas.root}/index`)) {
    const period = readNote(p)?.fm.period;
    if (typeof period === "string") writeIndex(atlas, period);
  }
}

/** Move everything in scope `from` into scope `to`. Overlapping sealed notes in `to` become stale. */
export function mergeScope(atlas: Atlas, from: string, to: string) {
  if (from === to) throw new Error("A scope cannot be merged into itself.");
  const fromDir = atlas.paths.scopeDir(from);
  if (!existsSync(fromDir)) throw new Error(`Scope "${from}" has no notes.`);
  const target = new ScopeView(atlas, to);
  const touchedDays = new Set<string>();
  const origins = new Map<string, "remote" | "path">();
  const movedPeriods: string[] = [];

  for (const path of listMarkdown(fromDir)) {
    const note = readNote(path)!;
    if (note.fm.atlas === "session") {
      writeNote(path.replace(fromDir, atlas.paths.scopeDir(to)), { ...note.fm, scope: to }, note.body);
      if (typeof note.fm.origin === "string") origins.set(note.fm.origin, note.fm.origin_kind === "remote" ? "remote" : "path");
      for (const d of Array.isArray(note.fm.days) ? (note.fm.days as string[]) : []) touchedDays.add(d);
    } else if (note.fm.atlas === "period") {
      const period = String(note.fm.period);
      const existing = target.note(period);
      if (!existing) {
        const sealed = note.fm.status === "sealed" || note.fm.status === "stale";
        if (sealed) {
          writeNote(atlas.paths.periodNote(to, period), { ...note.fm, scope: to }, note.body.replace(`# ${period} ${from}`, `# ${period} ${to}`));
          movedPeriods.push(period);
        }
      } else if (existing.fm.status === "sealed") {
        writeFrontmatter(existing, { status: "stale" });
        markParentsStale(atlas, to, period);
      }
    } else if (note.fm.atlas === "topic") {
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
  for (const [match, kind] of origins) {
    if (!file.rules.some((r) => r.kind === kind && r.match === match)) file.rules.push({ kind, match, scope: to });
  }
  const info = file.scopes[from];
  delete file.scopes[from];
  if (info?.isolated) file.scopes[to] = { ...file.scopes[to], isolated: true };
  writeScopes(atlas.paths.scopesFile, file);

  refreshAround(atlas, to, [...touchedDays].filter((d) => parsePeriod(d).layer === "day"));
  rebuildIndexes(atlas);
}
