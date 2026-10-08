import type { Atlas } from "./atlas.js";
import { ScopeView } from "./periods.js";
import { segmentHeadline, sessionDays } from "./sessions/note.js";
import { readNote } from "./store/note.js";
import { parentsOf, parsePeriod } from "./time/index.js";

export interface ZoomChild {
  id: string;
  layer: string;
  headline: string;
  status: string;
}

export function zoom(atlas: Atlas, scope: string, id: string) {
  const view = new ScopeView(atlas, scope);
  let period;
  try {
    period = parsePeriod(id);
  } catch {
    const session = view.sessions().find((s) => s.fm.session === id || s.path.endsWith(`${id}.md`));
    if (!session) throw new Error(`"${id}" is neither a period id nor a session in scope "${scope}".`);
    return {
      scope,
      id: String(session.fm.session),
      layer: "session",
      status: String(session.fm.status),
      headline: session.segments.map(segmentHeadline).join("; "),
      content: readNote(session.path)!.body.trim(),
      children: [] as ZoomChild[],
      parents: sessionDays(session),
    };
  }

  const children: ZoomChild[] =
    period.layer === "day"
      ? view.segmentsOn(id).map(({ session, segment }) => ({
          id: String(session.fm.session),
          layer: "session",
          headline: segmentHeadline(segment),
          status: String(session.fm.status),
        }))
      : view.childPeriods(id).map((c) => ({ id: c, layer: parsePeriod(c).layer, headline: view.headline(c), status: view.status(c) }));

  const sealed = view.isSealed(id);
  if (!sealed && !children.length) throw new Error(`No work is recorded for ${id} in scope "${scope}".`);
  return {
    scope,
    id,
    layer: period.layer as string,
    status: view.status(id) === "none" ? "draft" : view.status(id),
    headline: view.headline(id),
    content: sealed ? view.note(id)!.body.trim() : view.draftBody(id).trim(),
    children,
    parents: parentsOf(id),
  };
}
