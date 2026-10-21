import { type Frontmatter, type Note, writeNote } from "../store/note.js";

export const EVENT_TYPES = ["decision", "change", "finding", "todo", "note"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface SessionEvent {
  time: string;
  type: string;
  text: string;
  topics: string[];
}

export interface Segment {
  day: string;
  headline?: string;
  summary?: string;
  events: SessionEvent[];
  /** Written by the capture hooks from the transcript, never by the agent. */
  activity?: string;
}

export interface SessionNote {
  path: string;
  fm: Frontmatter;
  segments: Segment[];
}

const DAY_HEADING = /^## (\d{4}-\d{2}-\d{2})[ \t]*$/m;
const SUB_HEADING = /^### (Headline|Summary|Events|Activity)[ \t]*$/m;
const EVENT_LINE = /^- (\d{2}:\d{2}) ([a-z]+): (.*)$/;
const TOPIC_LINKS = /(?:\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\])+\s*$/;

function parseEvent(line: string): SessionEvent | undefined {
  const m = EVENT_LINE.exec(line.trim());
  if (!m) return undefined;
  let text = m[3] ?? "";
  const topics: string[] = [];
  const tail = TOPIC_LINKS.exec(text);
  if (tail) {
    for (const t of tail[0].matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) topics.push(t[1]!);
    text = text.slice(0, tail.index).trimEnd();
  }
  return { time: m[1]!, type: m[2]!, text, topics };
}

export function parseSession(note: Note): SessionNote {
  const parts = note.body.split(DAY_HEADING);
  const segments: Segment[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const day = parts[i]!;
    const chunks = (parts[i + 1] ?? "").split(SUB_HEADING);
    const seg: Segment = { day, events: [] };
    for (let j = 1; j < chunks.length; j += 2) {
      const content = (chunks[j + 1] ?? "").trim();
      if (chunks[j] === "Headline") seg.headline = content || undefined;
      else if (chunks[j] === "Summary") seg.summary = content || undefined;
      else if (chunks[j] === "Activity") seg.activity = content || undefined;
      else if (chunks[j] === "Events")
        seg.events = content.split("\n").map(parseEvent).filter((e): e is SessionEvent => Boolean(e));
    }
    segments.push(seg);
  }
  return { path: note.path, fm: note.fm, segments };
}

export function renderEvent(e: SessionEvent): string {
  const links = e.topics.map((t) => ` [[${t}]]`).join("");
  return `- ${e.time} ${e.type}: ${e.text}${links}`;
}

export function renderSegment(seg: Segment): string {
  const out = [`## ${seg.day}`, ""];
  if (seg.headline) out.push("### Headline", seg.headline, "");
  if (seg.summary) out.push("### Summary", seg.summary, "");
  if (seg.events.length) out.push("### Events", ...seg.events.map(renderEvent), "");
  if (seg.activity) out.push("### Activity", seg.activity, "");
  return out.join("\n");
}

export function renderSession(s: SessionNote): string {
  const started = String(s.fm.started ?? "");
  const title = `# Session ${started.slice(0, 10)} ${started.slice(11, 16)}`.trimEnd();
  return [title, "", ...s.segments.map(renderSegment)].join("\n");
}

export function saveSession(s: SessionNote): SessionNote {
  const days = s.segments.map((x) => x.day);
  const fm = { ...s.fm, days: days.length ? days : s.fm.days };
  const written = writeNote(s.path, fm, renderSession({ ...s, fm }));
  return { ...s, fm: written.fm };
}

/** True for sessions the capture skipped (headless runs, empty transcripts). They count toward no day. */
export function isSkipped(s: SessionNote): boolean {
  return s.fm.capture === "skipped" || s.fm.orphan === "skipped";
}

/** Days a session counts toward: its segments, or its start day for an orphan with none. */
export function sessionDays(s: SessionNote): string[] {
  if (isSkipped(s)) return [];
  if (s.segments.length) return s.segments.map((x) => x.day);
  return Array.isArray(s.fm.days) ? (s.fm.days as string[]) : [];
}

export function hasContent(seg: Segment): boolean {
  return Boolean(seg.headline || seg.summary || seg.events.length || seg.activity);
}

export function isOrphan(s: SessionNote): boolean {
  return s.fm.status === "closed" && !s.segments.some(hasContent) && typeof s.fm.transcript === "string" && !isSkipped(s);
}

/** One-line description of a segment for drafts and briefs. */
export function segmentHeadline(seg: Segment): string {
  if (seg.headline) return seg.headline;
  const first = seg.events[0];
  if (!first) return activityHeadline(seg.activity) ?? "(no events)";
  const more = seg.events.length > 1 ? ` (+${seg.events.length - 1} more events)` : "";
  return `${first.text}${more}`;
}

/** The session title at the top of an Activity section, or the first request. */
export function activityHeadline(activity: string | undefined): string | undefined {
  if (!activity) return undefined;
  const firstLine = activity.split("\n")[0]!.trim();
  if (firstLine && !firstLine.startsWith("- ")) return firstLine;
  const ask = /^- \d{2}:\d{2} asked: (.*)$/m.exec(activity)?.[1];
  return ask ? (ask.length > 120 ? `${ask.slice(0, 117)}...` : ask) : undefined;
}

/** The segment for `day`, created in date order if the session has none yet. */
export function segmentFor(s: SessionNote, day: string): Segment {
  let seg = s.segments.find((x) => x.day === day);
  if (!seg) {
    seg = { day, events: [] };
    s.segments.push(seg);
    s.segments.sort((a, b) => (a.day < b.day ? -1 : 1));
  }
  return seg;
}
