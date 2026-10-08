import type { Atlas } from "./atlas.js";
import { GENERAL } from "./scopes/index.js";
import { link, listMarkdown, noteName, readNote, writeNote } from "./store/note.js";

export interface TopicUpdate {
  /** Replaces "What we know now". */
  state?: string;
  /** Appended to the timeline, dated today. */
  entry?: string;
}

const STOP = new Set(["the", "a", "an", "of", "and", "for", "to", "in", "on", "with"]);

function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

function editRatio(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n]! / Math.max(m, n);
}

/** Whether two topic names probably mean the same subject. */
export function similarNames(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return false;
  const shared = wa.filter((x) => wb.some((y) => sameWord(x, y))).length;
  const overlap = shared / Math.max(wa.length, wb.length);
  return overlap >= 0.5 || editRatio(wa.join(" "), wb.join(" ")) >= 0.8;
}

export function topicNames(atlas: Atlas, scope: string): string[] {
  return listMarkdown(atlas.paths.topicsDir(scope)).map((p) => String(readNote(p)?.fm.topic ?? noteName(p)));
}

function findTopic(atlas: Atlas, scope: string, name: string): string | undefined {
  const want = name.trim().toLowerCase();
  return listMarkdown(atlas.paths.topicsDir(scope)).find((p) => String(readNote(p)?.fm.topic ?? noteName(p)).toLowerCase() === want);
}

function section(body: string, title: string): string | undefined {
  const m = new RegExp(`(?:^|\\n)## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body);
  return m ? m[1]!.trim() : undefined;
}

function replaceSection(body: string, title: string, content: string): string {
  const re = new RegExp(`((?:^|\\n)## ${title}\\n)([\\s\\S]*?)(?=\\n## |$)`);
  if (re.test(body)) return body.replace(re, (_m, head: string) => `${head}\n${content}\n`);
  return `${body.trimEnd()}\n\n## ${title}\n\n${content}\n`;
}

export interface TopicResult {
  name: string;
  scope: string;
  exists: boolean;
  created?: boolean;
  path?: string;
  content?: string;
  similar?: string[];
}

/**
 * Read, create or update a topic. `scopes` is the lookup order for reads (the session's
 * scope, then general); writes go to the first of them.
 */
export function topic(
  atlas: Atlas,
  scopes: string[],
  input: { name: string; update?: TopicUpdate; force?: boolean; source?: string },
): TopicResult {
  const name = input.name.trim().replace(/\s+/g, " ");
  const home = scopes[0]!;
  let path: string | undefined;
  let scope = home;
  for (const s of scopes) {
    path = findTopic(atlas, s, name);
    if (path) {
      scope = s;
      break;
    }
  }

  if (!input.update) {
    if (!path) {
      const similar = scopes.flatMap((s) => topicNames(atlas, s)).filter((n) => similarNames(n, name));
      return { name, scope: home, exists: false, similar };
    }
    return { name, scope, exists: true, path, content: readNote(path)!.body.trim() };
  }

  const state = input.update.state ? atlas.scrub(input.update.state.trim()) : undefined;
  const entry = input.update.entry
    ? `- ${atlas.today()} ${atlas.scrub(input.update.entry.replace(/\s*\n\s*/g, " ").trim())}${input.source ? ` ${input.source}` : ""}`
    : undefined;

  let created = false;
  if (!path) {
    const similar = topicNames(atlas, home).filter((n) => similarNames(n, name));
    if (similar.length && !input.force) {
      return { name, scope: home, exists: false, created: false, similar };
    }
    path = atlas.paths.topicNote(home, name);
    scope = home;
    created = true;
  }

  const existing = readNote(path);
  let body = existing?.body ?? `# ${name}\n\n## What we know now\n\n_Not yet written._\n\n## Timeline\n`;
  if (state) body = replaceSection(body, "What we know now", state);
  if (entry) {
    const timeline = section(body, "Timeline");
    body = replaceSection(body, "Timeline", timeline ? `${timeline}\n${entry}` : entry);
  }
  const stamp = atlas.stamp();
  writeNote(path, { atlas: "topic", scope, topic: name, created: existing?.fm.created ?? stamp, updated: stamp }, body);
  return { name, scope, exists: true, created, path, content: body.trim() };
}

export function topicScopes(scope: string): string[] {
  return scope === GENERAL ? [GENERAL] : [scope, GENERAL];
}

export { link };
