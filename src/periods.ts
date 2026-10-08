import type { Atlas } from "./atlas.js";
import { tokens } from "./config.js";
import { isIsolated } from "./scopes/index.js";
import { hasContent, renderEvent, type Segment, segmentHeadline, type SessionNote, sessionDays } from "./sessions/note.js";
import { isHumanEdited, link, listMarkdown, type Note, readNote, writeFrontmatter, writeNote } from "./store/note.js";
import { daysOf, type Layer, parentsOf, parsePeriod, periodOf, rangeOf } from "./time/index.js";

export type PeriodStatus = "none" | "draft" | "sealed" | "stale";

export interface DaySegment {
  session: SessionNote;
  segment: Segment;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function weekday(day: string): string {
  return WEEKDAY[new Date(`${day}T12:00:00Z`).getUTCDay()]!;
}

/** Read-side view over one scope's sessions and period notes. */
export class ScopeView {
  private sessionsCache?: SessionNote[];

  constructor(
    readonly atlas: Atlas,
    readonly scope: string,
  ) {}

  sessions(): SessionNote[] {
    this.sessionsCache ??= this.atlas.sessionNotes(this.scope);
    return this.sessionsCache;
  }

  /** Every day that has session work in this scope, ascending. */
  workedDays(): string[] {
    const days = new Set<string>();
    for (const s of this.sessions()) for (const d of sessionDays(s)) days.add(d);
    for (const p of listMarkdown(`${this.atlas.paths.scopeDir(this.scope)}/days`)) {
      const n = readNote(p);
      if (typeof n?.fm.period === "string") days.add(n.fm.period);
    }
    return [...days].sort();
  }

  workedDaysIn(period: string): string[] {
    const { first, last } = rangeOf(period);
    return this.workedDays().filter((d) => d >= first && d <= last);
  }

  /** Periods at `layer` that contain worked days. */
  workedPeriods(layer: Layer): string[] {
    return [...new Set(this.workedDays().map((d) => periodOf(layer, d)))].sort();
  }

  segmentsOn(day: string): DaySegment[] {
    const out: DaySegment[] = [];
    for (const session of this.sessions()) {
      const segment = session.segments.find((x) => x.day === day);
      if (segment && hasContent(segment)) out.push({ session, segment });
    }
    return out.sort((a, b) => String(a.session.fm.started).localeCompare(String(b.session.fm.started)));
  }

  note(period: string): Note | undefined {
    return readNote(this.atlas.paths.periodNote(this.scope, period));
  }

  status(period: string): PeriodStatus {
    const n = this.note(period);
    if (!n) return "none";
    const s = n.fm.status;
    return s === "sealed" || s === "stale" || s === "draft" ? s : "draft";
  }

  isSealed(period: string): boolean {
    const s = this.status(period);
    return s === "sealed" || s === "stale";
  }

  headline(period: string): string {
    const n = this.note(period);
    if (n && this.isSealed(period) && typeof n.fm.headline === "string") return n.fm.headline;
    return this.draftHeadline(period);
  }

  /** The children a period is built from: sessions for a day, days for weeks and months, months for a year. */
  childPeriods(period: string): string[] {
    const { layer } = parsePeriod(period);
    if (layer === "week" || layer === "month") return this.workedDaysIn(period);
    if (layer === "year") return this.workedPeriods("month").filter((m) => m.startsWith(period));
    return [];
  }

  draftHeadline(period: string): string {
    const { layer } = parsePeriod(period);
    const parts =
      layer === "day"
        ? this.segmentsOn(period).map((x) => segmentHeadline(x.segment))
        : this.childPeriods(period).map((c) => this.headline(c));
    const text = parts.join("; ");
    const label = layer === "day" ? `${parts.length} session${parts.length === 1 ? "" : "s"}` : `${parts.length} ${layer === "year" ? "months" : "days"}`;
    const joined = `${label}: ${text}`;
    return joined.length > 200 ? `${joined.slice(0, 197)}...` : joined;
  }

  draftBody(period: string): string {
    const { layer } = parsePeriod(period);
    const lines = [`# ${period} ${this.scope} (draft)`, ""];
    if (layer === "day") {
      for (const { session, segment } of this.segmentsOn(period)) {
        const time = String(session.fm.started).slice(11, 16);
        lines.push(`- ${time} ${link(session.path, time)} ${segmentHeadline(segment)}`);
      }
    } else {
      for (const child of this.childPeriods(period)) {
        const label = layer === "year" ? child : `${weekday(child)} ${child.slice(8)}`;
        const n = this.note(child);
        const ref = n ? link(n.path, label) : label;
        lines.push(`- ${ref} ${this.headline(child)}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  /** Rewrite the draft note for an unsealed period, unless a human has edited it. */
  writeDraft(period: string) {
    if (this.isSealed(period)) return;
    const existing = this.note(period);
    if (existing && (existing.fm.human_edited || isHumanEdited(existing))) {
      if (!existing.fm.human_edited) writeFrontmatter(existing, { human_edited: true });
      return;
    }
    const empty = parsePeriod(period).layer === "day" ? !this.segmentsOn(period).length : !this.childPeriods(period).length;
    if (empty) return;
    writeNote(
      this.atlas.paths.periodNote(this.scope, period),
      {
        atlas: "period",
        layer: parsePeriod(period).layer,
        period,
        scope: this.scope,
        status: "draft",
        headline: this.draftHeadline(period),
      },
      this.draftBody(period),
    );
  }

  /** Text a human wrote into a draft, which the rollup must take into account. */
  humanDraftText(period: string): string | undefined {
    const n = this.note(period);
    if (n && !this.isSealed(period) && (n.fm.human_edited || isHumanEdited(n))) return n.body.trim();
    return undefined;
  }
}

export function renderSegmentSource({ session, segment }: DaySegment): string {
  const time = String(session.fm.started).slice(11, 16);
  const out = [`### ${link(session.path)} (started ${time})`];
  if (segment.headline) out.push(`Headline: ${segment.headline}`);
  if (segment.summary) out.push("", segment.summary);
  if (segment.events.length) out.push("", "Events:", ...segment.events.map(renderEvent));
  return out.join("\n");
}

/** Refresh drafts for a day and every period above it, plus the matching index notes. */
export function refreshAround(atlas: Atlas, scope: string, days: string[]) {
  const view = new ScopeView(atlas, scope);
  const periods = new Set<string>();
  for (const day of days) {
    periods.add(day);
    for (const layer of ["week", "month", "year"] as const) periods.add(periodOf(layer, day));
  }
  for (const p of periods) view.writeDraft(p);
  for (const p of periods) writeIndex(atlas, p);
}

export function allScopes(atlas: Atlas): string[] {
  return listMarkdown(atlas.paths.scopesRoot())
    .map((p) => p.slice(atlas.paths.scopesRoot().length + 1).split("/")[0]!)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
}

/** Rebuild the index note for a period from every non-isolated scope's headline. */
export function writeIndex(atlas: Atlas, period: string) {
  const file = atlas.scopes();
  const path = atlas.paths.indexNote(period);
  const existing = readNote(path);
  if (existing && isHumanEdited(existing)) return;
  const lines: string[] = [];
  for (const scope of allScopes(atlas)) {
    if (isIsolated(scope, file)) continue;
    const view = new ScopeView(atlas, scope);
    const n = view.note(period);
    if (!n) continue;
    const mark = view.isSealed(period) ? "" : " (draft)";
    lines.push(`- **${scope}**${mark}: ${view.headline(period)} ${link(n.path, "open")}`);
  }
  if (!lines.length && !existing) return;
  writeNote(
    path,
    { atlas: "index", layer: parsePeriod(period).layer, period },
    `# ${period}\n\n${lines.join("\n") || "_No visible work in this period._"}\n`,
  );
}

/** Mark every sealed note above `period` stale, recursively. Returns the periods marked. */
export function markParentsStale(atlas: Atlas, scope: string, period: string): string[] {
  const view = new ScopeView(atlas, scope);
  const marked: string[] = [];
  for (const parent of parentsOf(period)) {
    const n = view.note(parent);
    if (n && n.fm.status === "sealed") {
      writeFrontmatter(n, { status: "stale" });
      marked.push(parent);
    }
    if (n && (n.fm.status === "sealed" || n.fm.status === "stale")) marked.push(...markParentsStale(atlas, scope, parent));
  }
  return [...new Set(marked)];
}

export { tokens, daysOf };
