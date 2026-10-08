import type { Atlas } from "./atlas.js";
import { markParentsStale, ScopeView } from "./periods.js";
import { sessionDays } from "./sessions/note.js";
import { hashBody, isHumanEdited, listMarkdown, readNote, writeFrontmatter, writeNote } from "./store/note.js";
import { parsePeriod } from "./time/index.js";

/**
 * Find notes a human edited since the server last wrote them. The edit is accepted as
 * correct (the stored hash is updated) and every sealed note built on it becomes stale.
 */
export function scanEdits(atlas: Atlas, scope: string): string[] {
  const stale: string[] = [];
  const view = new ScopeView(atlas, scope);
  for (const path of listMarkdown(atlas.paths.scopeDir(scope))) {
    const note = readNote(path);
    if (!note || !isHumanEdited(note)) continue;
    const kind = note.fm.atlas;
    if (kind === "period" && (note.fm.status === "sealed" || note.fm.status === "stale")) {
      writeFrontmatter(note, { atlas_hash: hashBody(note.body) });
      stale.push(...markParentsStale(atlas, scope, String(note.fm.period)));
    } else if (kind === "session") {
      writeFrontmatter(note, { atlas_hash: hashBody(note.body) });
      for (const day of Array.isArray(note.fm.days) ? (note.fm.days as string[]) : []) {
        const dayNote = view.note(day);
        if (dayNote?.fm.status === "sealed") {
          writeFrontmatter(dayNote, { status: "stale" });
          stale.push(day, ...markParentsStale(atlas, scope, day));
        }
      }
    }
    // Drafts are handled when they are next regenerated; topics and index notes need nothing.
  }
  return [...new Set(stale)];
}

export interface AmendInput {
  note: string;
  change: string;
  reason: string;
}

/** Append a dated correction to a sealed period note or a session note. */
export function amend(atlas: Atlas, scope: string, input: AmendInput) {
  const view = new ScopeView(atlas, scope);
  const change = atlas.scrub(input.change.replace(/\s*\n\s*/g, " ").trim());
  const reason = atlas.scrub(input.reason.replace(/\s*\n\s*/g, " ").trim());
  const entry = `- ${atlas.today()}: ${change} (Reason: ${reason})`;

  let isPeriod = true;
  try {
    parsePeriod(input.note);
  } catch {
    isPeriod = false;
  }

  if (isPeriod) {
    const note = view.note(input.note);
    if (!note) throw new Error(`There is no note for ${input.note} in scope "${scope}".`);
    if (!view.isSealed(input.note)) {
      throw new Error(`${input.note} is a draft. Drafts follow their sessions; log an event instead of amending it.`);
    }
    writeNote(note.path, note.fm, appendAmendment(note.body, entry));
    return { note: input.note, path: note.path, nowStale: markParentsStale(atlas, scope, input.note) };
  }

  const session = view.sessions().find((s) => s.fm.session === input.note);
  if (!session) throw new Error(`"${input.note}" is neither a period id nor a session id in scope "${scope}".`);
  const note = readNote(session.path)!;
  writeNote(note.path, note.fm, appendAmendment(note.body, entry));
  const nowStale: string[] = [];
  for (const day of sessionDays(session)) {
    const dayNote = view.note(day);
    if (dayNote?.fm.status === "sealed") {
      writeFrontmatter(dayNote, { status: "stale" });
      nowStale.push(day, ...markParentsStale(atlas, scope, day));
    }
  }
  return { note: input.note, path: note.path, nowStale: [...new Set(nowStale)] };
}

function appendAmendment(body: string, entry: string): string {
  const trimmed = body.trimEnd();
  const prev = trimmed.indexOf("\n## Previous version");
  const main = prev === -1 ? trimmed : trimmed.slice(0, prev);
  const rest = prev === -1 ? "" : trimmed.slice(prev);
  const withEntry = main.includes("\n## Amendments\n") ? `${main}\n${entry}` : `${main}\n\n## Amendments\n\n${entry}`;
  return `${withEntry}${rest}\n`;
}

export { listMarkdown };
