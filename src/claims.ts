import { createHash } from "node:crypto";

/**
 * Claims and open items: the dated lines in a topic note. A claim is something true about the
 * topic from a day on; an open item is something still to do or decide. Neither is deleted:
 * a replaced claim or a resolved item moves to History with the day it ended. Each line ends
 * in an Obsidian block id (^c1a2b3, ^o1a2b3), so later rollups can name it and notes can link it.
 *
 *   - Enterprise users sign in through Okta with SAML. (since 2026-09-09, [[2026-09-09T0900-fx0012]]) ^c3k9xa
 *   - Decide the session lifetime for SAML users. (open since 2026-09-12, [[2026-09-12 billing-api]]) ^o81kd2
 *   - ~~Everyone signs in with magic links.~~ (since 2026-08-01, until 2026-09-09, replaced by ^c3k9xa) ^c0aa1z
 */

export interface Claim {
  id: string;
  text: string;
  since: string;
  source?: string;
}

export interface OpenItem {
  id: string;
  text: string;
  since: string;
  source?: string;
}

export interface HistoryLine {
  id: string;
  text: string;
  /** Everything inside the parentheses: since, until, replaced by, resolved. */
  detail: string;
  /** The first day the line held, and the day it stopped. */
  since?: string;
  until?: string;
}

const CLAIM = /^- (.+) \(since (\d{4}-\d{2}-\d{2})(?:, (.+?))?\) \^(c[0-9a-z]{5,})$/;
const OPEN = /^- (.+) \(open since (\d{4}-\d{2}-\d{2})(?:, (.+?))?\) \^(o[0-9a-z]{5,})$/;
const HISTORY = /^- ~~(.+)~~ \((.+)\) \^([co][0-9a-z]{5,})$/;

export function parseClaim(line: string): Claim | undefined {
  const m = CLAIM.exec(line.trim());
  return m ? { text: m[1]!, since: m[2]!, source: m[3], id: m[4]! } : undefined;
}

export function parseOpen(line: string): OpenItem | undefined {
  const m = OPEN.exec(line.trim());
  return m ? { text: m[1]!, since: m[2]!, source: m[3], id: m[4]! } : undefined;
}

export function parseHistory(line: string): HistoryLine | undefined {
  const m = HISTORY.exec(line.trim());
  if (!m) return undefined;
  const detail = m[2]!;
  const since = /(?:since|open) (\d{4}-\d{2}-\d{2})/.exec(detail)?.[1];
  const until = /(?:until|resolved) (\d{4}-\d{2}-\d{2})/.exec(detail)?.[1];
  return { text: m[1]!, detail, id: m[3]!, since, until };
}

export const renderClaim = (c: Claim) => `- ${c.text} (since ${c.since}${c.source ? `, ${c.source}` : ""}) ^${c.id}`;
export const renderOpen = (o: OpenItem) => `- ${o.text} (open since ${o.since}${o.source ? `, ${o.source}` : ""}) ^${o.id}`;
export const renderHistory = (h: { id: string; text: string; detail: string }) => `- ~~${h.text}~~ (${h.detail}) ^${h.id}`;

/** A stable id from the topic, the text and the day, so the same claim gets the same id on every machine. */
export function lineId(kind: "c" | "o", topic: string, text: string, since: string, taken: Set<string>): string {
  for (let salt = 0; ; salt++) {
    const hash = createHash("sha256").update(`${topic}\n${text}\n${since}\n${salt}`).digest();
    const id = kind + hash.readUIntBE(0, 4).toString(36).padStart(6, "0").slice(0, 6);
    if (!taken.has(id)) return id;
  }
}

/** One claim or item text: one line, no strike-through marks, at most 300 characters. */
export function cleanText(text: string): string {
  const flat = text.replace(/\s+/g, " ").replace(/~~/g, "").trim();
  if (!flat) throw new Error("A claim or open item needs text.");
  if (flat.length > 300) throw new Error(`Keep a claim or open item to one sentence (at most 300 characters): "${flat.slice(0, 60)}..."`);
  return flat;
}
