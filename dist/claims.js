import { createHash } from "node:crypto";
const CLAIM = /^- (.+) \(since (\d{4}-\d{2}-\d{2})(?:, (.+?))?\) \^(c[0-9a-z]{5,})$/;
const OPEN = /^- (.+) \(open since (\d{4}-\d{2}-\d{2})(?:, (.+?))?\) \^(o[0-9a-z]{5,})$/;
const HISTORY = /^- ~~(.+)~~ \((.+)\) \^([co][0-9a-z]{5,})$/;
export function parseClaim(line) {
    const m = CLAIM.exec(line.trim());
    return m ? { text: m[1], since: m[2], source: m[3], id: m[4] } : undefined;
}
export function parseOpen(line) {
    const m = OPEN.exec(line.trim());
    return m ? { text: m[1], since: m[2], source: m[3], id: m[4] } : undefined;
}
export function parseHistory(line) {
    const m = HISTORY.exec(line.trim());
    if (!m)
        return undefined;
    const detail = m[2];
    const since = /(?:since|open) (\d{4}-\d{2}-\d{2})/.exec(detail)?.[1];
    const until = /(?:until|resolved) (\d{4}-\d{2}-\d{2})/.exec(detail)?.[1];
    return { text: m[1], detail, id: m[3], since, until };
}
export const renderClaim = (c) => `- ${c.text} (since ${c.since}${c.source ? `, ${c.source}` : ""}) ^${c.id}`;
export const renderOpen = (o) => `- ${o.text} (open since ${o.since}${o.source ? `, ${o.source}` : ""}) ^${o.id}`;
export const renderHistory = (h) => `- ~~${h.text}~~ (${h.detail}) ^${h.id}`;
/** A stable id from the topic, the text and the day, so the same claim gets the same id on every machine. */
export function lineId(kind, topic, text, since, taken) {
    for (let salt = 0;; salt++) {
        const hash = createHash("sha256").update(`${topic}\n${text}\n${since}\n${salt}`).digest();
        const id = kind + hash.readUIntBE(0, 4).toString(36).padStart(6, "0").slice(0, 6);
        if (!taken.has(id))
            return id;
    }
}
/** One claim or item text: one line, no strike-through marks, at most 300 characters. */
export function cleanText(text) {
    const flat = text.replace(/\s+/g, " ").replace(/~~/g, "").trim();
    if (!flat)
        throw new Error("A claim or open item needs text.");
    if (flat.length > 300)
        throw new Error(`Keep a claim or open item to one sentence (at most 300 characters): "${flat.slice(0, 60)}..."`);
    return flat;
}
