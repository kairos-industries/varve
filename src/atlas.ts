import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type AtlasConfig, loadConfig } from "./config.js";
import { scrub } from "./scrub/index.js";
import { buildBrief } from "./brief.js";
import { amend, type AmendInput, scanEdits } from "./edits.js";
import { search } from "./search.js";
import { mergeScope, rebuildIndexes } from "./scopes/manage.js";
import { topic, type TopicUpdate, topicScopes } from "./topics.js";
import { zoom } from "./zoom.js";
import { allScopes, refreshAround, writeIndex } from "./periods.js";
import { transcriptText } from "./sessions/transcript.js";
import { pending, seal, type SealInput, summarize } from "./rollup/index.js";
import { canRead, detectScope, GENERAL, readScopes, type ScopeRule, type ScopesFile, slug, writeScopes } from "./scopes/index.js";
import {
  parseSession,
  saveSession,
  type Segment,
  type SessionNote,
} from "./sessions/note.js";
import { withMutex } from "./store/lock.js";
import { link, listMarkdown, readNote, writeNote } from "./store/note.js";
import { join } from "node:path";
import { AtlasPaths } from "./store/paths.js";
import { type Clock, dayOf, systemClock, wallClock } from "./time/index.js";

export interface AtlasOptions {
  dir: string;
  clock?: Clock;
  config?: Partial<AtlasConfig>;
}

export interface RegistryEntry {
  id: string;
  scope?: string;
  path?: string;
  cwd?: string;
  clientSessionId?: string;
  client?: string;
  transcript?: string;
  startedAt: string;
}

type Registry = Record<string, RegistryEntry>;

export class Atlas {
  readonly paths: AtlasPaths;
  readonly config: AtlasConfig;
  readonly clock: Clock;

  constructor(opts: AtlasOptions) {
    this.paths = new AtlasPaths(opts.dir);
    this.config = loadConfig(opts.dir, opts.config);
    this.clock = opts.clock ?? systemClock;
  }

  get root(): string {
    return this.paths.root;
  }

  now(): Date {
    return this.clock();
  }

  today(): string {
    return dayOf(this.now(), this.config);
  }

  /** Local ISO timestamp with offset, e.g. 2026-10-08T14:32:00+02:00. */
  stamp(at: Date = this.now()): string {
    const { date, time, seconds } = wallClock(at, this.config);
    const zone = this.config.timezone === "local" ? undefined : this.config.timezone;
    const offset =
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")
        ?.value.replace("GMT", "") || "+00:00";
    return `${date}T${time}:${seconds}${offset}`;
  }

  scrub(text: string): string {
    return scrub(text, this.config.scrubPatterns);
  }

  scopes(): ScopesFile {
    return readScopes(this.paths.scopesFile);
  }

  // ---- session registry (.atlas/sessions.json) ----

  updateRegistry<T>(fn: (reg: Registry) => T): T {
    const file = this.paths.sessionsFile;
    mkdirSync(dirname(file), { recursive: true });
    return withMutex(file, () => {
      const reg: Registry = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      const out = fn(reg);
      writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);
      return out;
    });
  }

  readRegistry(): Registry {
    const file = this.paths.sessionsFile;
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }

  // ---- reading sessions ----

  sessionNotes(scope: string): SessionNote[] {
    return listMarkdown(this.paths.sessionsDir(scope)).map((p) => parseSession(readNote(p)!));
  }

  session(opts: SessionOptions = {}): AtlasSession {
    return new AtlasSession(this, opts);
  }

  // ---- hooks ----

  hookStart(input: HookInput) {
    const scope = detectScope(input.cwd, this.scopes()).scope;
    this.updateRegistry((reg) => {
      const prev = reg[input.sessionId];
      reg[input.sessionId] = {
        ...prev,
        id: prev?.id ?? newSessionId(),
        scope: prev?.scope ?? scope,
        cwd: input.cwd ?? prev?.cwd,
        clientSessionId: input.sessionId,
        client: input.client ?? prev?.client ?? "claude-code",
        transcript: input.transcriptPath ?? prev?.transcript,
        startedAt: prev?.startedAt ?? this.stamp(),
      };
      pruneRegistry(reg, this.now());
    });
    return { scope };
  }

  hookEnd(input: HookInput) {
    const entry = this.updateRegistry((reg) => {
      const e = reg[input.sessionId];
      delete reg[input.sessionId];
      return e;
    });
    const transcript = input.transcriptPath ?? entry?.transcript;
    if (entry?.path && existsSync(entry.path)) {
      const s = parseSession(readNote(entry.path)!);
      s.fm.status = "closed";
      s.fm.ended ??= this.stamp();
      if (transcript) s.fm.transcript = transcript;
      saveSession(s);
      refreshAround(this, String(s.fm.scope), s.segments.map((x) => x.day));
      return { result: "closed", path: entry.path };
    }
    if (!transcript || transcriptText(transcript, this.config.orphanMinChars + 1).length < this.config.orphanMinChars) {
      return { result: "skipped" };
    }
    const scope = entry?.scope ?? detectScope(input.cwd, this.scopes()).scope;
    const started = entry?.startedAt ? new Date(entry.startedAt) : this.now();
    const id = entry?.id ?? newSessionId();
    const { date, time } = wallClock(started, this.config);
    const path = this.paths.sessionNote(scope, date, time, id);
    writeNote(
      path,
      {
        atlas: "session",
        scope,
        session: id,
        started: this.stamp(started),
        ended: this.stamp(),
        status: "closed",
        client: entry?.client ?? "claude-code",
        client_session_id: input.sessionId,
        transcript,
        days: [dayOf(started, this.config)],
      },
      `# Session ${date} ${time}\n\nRecorded by a hook only. Summarize it from its transcript.\n`,
    );
    return { result: "orphan", path };
  }
}

const USAGE = `Temporal Atlas is your memory of past work, layered by time: sessions, days, weeks, months, years. The current scope is "{scope}".
- During work, call log for each decision (with the reason), notable change, finding or todo.
- Before you finish, call close_session with a one-line headline and a summary using ### Done, ### Decisions, ### Open threads.
- If a tool result reports pending rollups, work through them with summarize and seal. Past the cost gate, ask the user first.
- For more history: brief (wider view), zoom (open any period or session), search (keywords), topic (durable knowledge).
`;

export interface ScopeChange {
  scope: string;
  isolated?: boolean;
  /** Map this session's git remote (or folder) to `scope` for future sessions. */
  mapHere?: boolean;
  /** Move every note of `scope` into this scope. */
  mergeInto?: string;
}

export interface HookInput {
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
  client?: string;
}

const REGISTRY_TTL_MS = 7 * 24 * 3600 * 1000;

function pruneRegistry(reg: Registry, now: Date) {
  for (const [key, e] of Object.entries(reg)) {
    if (now.getTime() - new Date(e.startedAt).getTime() > REGISTRY_TTL_MS) delete reg[key];
  }
}

export interface SessionOptions {
  cwd?: string;
  clientSessionId?: string;
  client?: string;
  transcript?: string;
}

export interface LogInput {
  type: string;
  text: string;
  topics?: string[];
  scope?: string;
}

export interface CloseInput {
  headline: string;
  summary: string;
  segment?: string;
}

export class AtlasSession {
  readonly id: string;
  readonly started: Date;
  scope: string;
  private readonly key: string;
  private path?: string;
  private scopeLocked = false;
  private cwd?: string;
  private transcript?: string;
  private readonly client?: string;
  private readonly clientSessionId?: string;
  private lastDay: string;
  private readonly origin?: { kind: "remote" | "path"; match: string };

  constructor(
    readonly atlas: Atlas,
    opts: SessionOptions,
  ) {
    this.started = atlas.now();
    this.lastDay = atlas.today();
    this.clientSessionId = opts.clientSessionId;
    this.client = opts.client;
    this.key = opts.clientSessionId ?? `mcp-${randomBytes(6).toString("hex")}`;
    const fromHook = opts.clientSessionId ? atlas.readRegistry()[opts.clientSessionId] : undefined;
    this.id = fromHook?.id ?? newSessionId();
    this.cwd = opts.cwd ?? fromHook?.cwd;
    this.transcript = opts.transcript ?? fromHook?.transcript;
    const det = detectScope(this.cwd, atlas.scopes());
    this.origin = det.remote ? { kind: "remote", match: det.remote } : det.gitRoot || this.cwd ? { kind: "path", match: det.gitRoot ?? this.cwd! } : undefined;
    this.scope = fromHook?.scope ?? det.scope;
    if (fromHook?.path && existsSync(fromHook.path)) {
      this.path = fromHook.path;
      this.scope = String(readNote(fromHook.path)!.fm.scope ?? this.scope);
      this.scopeLocked = true;
    }
    atlas.updateRegistry((reg) => {
      reg[this.key] = {
        ...reg[this.key],
        id: this.id,
        scope: this.scope,
        cwd: this.cwd,
        clientSessionId: this.clientSessionId,
        client: this.client,
        transcript: this.transcript,
        startedAt: reg[this.key]?.startedAt ?? atlas.stamp(this.started),
        path: this.path,
      };
    });
  }

  get notePath(): string | undefined {
    return this.path;
  }

  /** The session note, creating it on first write. */
  private load(): SessionNote {
    if (this.path) {
      const note = readNote(this.path);
      if (note) return parseSession(note);
    }
    const { date, time } = wallClock(this.started, this.atlas.config);
    this.path = this.atlas.paths.sessionNote(this.scope, date, time, this.id);
    this.scopeLocked = true;
    const path = this.path;
    this.atlas.updateRegistry((reg) => {
      if (reg[this.key]) reg[this.key]!.path = path;
    });
    return {
      path,
      fm: {
        atlas: "session",
        scope: this.scope,
        session: this.id,
        started: this.atlas.stamp(this.started),
        status: "open",
        client: this.client,
        client_session_id: this.clientSessionId,
        transcript: this.transcript,
        origin: this.origin?.match,
        origin_kind: this.origin?.kind,
      },
      segments: [],
    };
  }

  private segment(s: SessionNote, day: string): Segment {
    let seg = s.segments.find((x) => x.day === day);
    if (!seg) {
      seg = { day, events: [] };
      s.segments.push(seg);
      s.segments.sort((a, b) => (a.day < b.day ? -1 : 1));
    }
    return seg;
  }

  log(input: LogInput) {
    if (input.scope && !this.scopeLocked) {
      this.scope = slug(input.scope);
      this.atlas.updateRegistry((reg) => {
        if (reg[this.key]) reg[this.key]!.scope = this.scope;
      });
    }
    const s = this.load();
    const now = this.atlas.now();
    const seg = this.segment(s, dayOf(now, this.atlas.config));
    const event = {
      time: wallClock(now, this.atlas.config).time,
      type: slug(input.type).replace(/-/g, "") || "note",
      text: this.atlas.scrub(input.text.replace(/\s*\n\s*/g, " ").trim()),
      topics: (input.topics ?? []).map((t) => t.trim()).filter(Boolean),
    };
    seg.events.push(event);
    s.fm.status = "open";
    delete s.fm.ended;
    saveSession(s);
    return { session: this.id, scope: this.scope, day: seg.day, event };
  }

  closeSession(input: CloseInput) {
    const s = this.load();
    const today = dayOf(this.atlas.now(), this.atlas.config);
    const day = input.segment ?? today;
    const seg = this.segment(s, day);
    seg.headline = this.atlas.scrub(input.headline.replace(/\s*\n\s*/g, " ").trim());
    seg.summary = this.atlas.scrub(input.summary.trim());
    if (day === today) {
      s.fm.status = "closed";
      s.fm.ended = this.atlas.stamp();
    }
    saveSession(s);
    refreshAround(this.atlas, this.scope, s.segments.map((x) => x.day));
    const checkpoint = this.pending();
    return { session: this.id, scope: this.scope, segment: day, closed: day === today, pending: checkpoint };
  }

  /** Scopes this session may read. */
  visibleScopes(): string[] {
    const file = this.atlas.scopes();
    return [...new Set([...allScopes(this.atlas), this.scope, GENERAL])].filter((s) => canRead(this.scope, s, file)).sort();
  }

  /** Resolve an optional scope argument, enforcing visibility. */
  resolveScope(scope?: string): string {
    if (!scope) return this.scope;
    const target = slug(scope);
    if (!canRead(this.scope, target, this.atlas.scopes())) {
      throw new Error(`Scope "${target}" is isolated and cannot be read from scope "${this.scope}".`);
    }
    return target;
  }

  /** Pending rollups for this scope, or for every visible scope with `all`. */
  pending(opts: { all?: boolean } = {}) {
    const scopes = opts.all ? this.visibleScopes() : [this.scope];
    for (const scope of scopes) scanEdits(this.atlas, scope);
    return pending(this.atlas, scopes);
  }

  brief(input: { scope?: string; lookback?: number } = {}) {
    const scope = this.resolveScope(input.scope);
    for (const sc of this.visibleScopes()) scanEdits(this.atlas, sc);
    return buildBrief(this.atlas, {
      scope,
      visible: this.visibleScopes(),
      lookback: input.lookback,
      capTokens: this.atlas.config.briefTokens.tool,
    });
  }

  /** The text returned as MCP server instructions: a compact brief plus how to use the tools. */
  instructions(): string {
    const usage = USAGE.replace("{scope}", this.scope);
    const cap = this.atlas.config.briefTokens.instructions - Math.ceil(usage.length / 4);
    const brief = buildBrief(this.atlas, { scope: this.scope, visible: this.visibleScopes(), compact: true, capTokens: cap });
    return `${usage}\n${brief}`;
  }

  zoom(input: { period: string; scope?: string }) {
    return zoom(this.atlas, this.resolveScope(input.scope), input.period);
  }

  search(input: { query: string; scope?: string; layer?: string; from?: string; to?: string; limit?: number }) {
    const scopes = input.scope ? [this.resolveScope(input.scope)] : this.visibleScopes();
    return search(this.atlas, { ...input, scopes });
  }

  amend(input: AmendInput & { scope?: string }) {
    return amend(this.atlas, this.resolveScope(input.scope), input);
  }

  /** Called when the client disconnects. */
  disconnect() {
    if (!this.path) return;
    const note = readNote(this.path);
    if (!note || note.fm.status === "closed") return;
    const s = parseSession(note);
    s.fm.status = "closed";
    s.fm.ended = this.atlas.stamp();
    saveSession(s);
    refreshAround(this.atlas, this.scope, s.segments.map((x) => x.day));
  }

  summarize(input: { period: string; scope?: string; confirmed?: boolean }) {
    return summarize(this.atlas, this.key, this.resolveScope(input.scope), input.period, input.confirmed);
  }

  seal(input: SealInput & { scope?: string; topicUpdates?: (TopicUpdate & { name: string })[] }) {
    const scope = this.resolveScope(input.scope);
    const result = seal(this.atlas, this.key, scope, input);
    const topics = (input.topicUpdates ?? []).map((u) =>
      topic(this.atlas, [scope], { name: u.name, update: { state: u.state, entry: u.entry }, force: true, source: link(result.path) }),
    );
    return { ...result, topics: topics.map((x) => x.name) };
  }

  scopes(input: { set?: ScopeChange } = {}) {
    const set = input.set;
    if (set) {
      const target = slug(set.scope);
      if (set.isolated !== undefined) {
        const file = this.atlas.scopes();
        file.scopes[target] = { ...file.scopes[target], isolated: set.isolated };
        writeScopes(this.atlas.paths.scopesFile, file);
        rebuildIndexes(this.atlas);
      }
      if (set.mapHere) {
        const det = detectScope(this.cwd, this.atlas.scopes());
        const rule: ScopeRule | undefined = det.remote
          ? { kind: "remote", match: det.remote, scope: target }
          : this.cwd
            ? { kind: "path", match: det.gitRoot ?? this.cwd, scope: target }
            : undefined;
        if (!rule) throw new Error("This session has no working directory to map.");
        const file = this.atlas.scopes();
        file.rules = [...file.rules.filter((r) => !(r.kind === rule.kind && r.match === rule.match)), rule];
        writeScopes(this.atlas.paths.scopesFile, file);
        if (!this.scopeLocked) this.scope = target;
      }
      if (set.mergeInto) {
        const into = slug(set.mergeInto);
        mergeScope(this.atlas, target, into);
        if (this.scope === target) this.scope = into;
      }
    }
    const file = this.atlas.scopes();
    return {
      current: this.scope,
      scopes: this.visibleScopes().map((name) => ({ name, isolated: Boolean(file.scopes[name]?.isolated) })),
      rules: file.rules.filter((r) => this.visibleScopes().includes(r.scope)),
    };
  }

  topic(input: { name: string; scope?: string; update?: TopicUpdate; force?: boolean }) {
    const scopes = input.scope ? [this.resolveScope(input.scope)] : topicScopes(this.scope);
    const source = this.path && existsSync(this.path) ? link(this.path) : undefined;
    return topic(this.atlas, scopes, { ...input, source });
  }

  /**
   * Day-change checkpoint: on the first call after a day boundary, returns a notice asking
   * the agent to summarize the finished part of this session and listing pending rollups.
   */
  checkpoint(): string | undefined {
    const today = this.atlas.today();
    if (today === this.lastDay) return undefined;
    const previous = this.lastDay;
    this.lastDay = today;
    const lines: string[] = [];
    const note = this.path ? readNote(this.path) : undefined;
    if (note) {
      const unsummarized = parseSession(note).segments.filter((x) => x.day >= previous && x.day < today && !x.summary);
      for (const seg of unsummarized) {
        lines.push(`The day ${seg.day} has ended. Summarize this session's part of it now: call close_session with segment: "${seg.day}", a headline and a summary. The session stays open.`);
      }
    }
    const p = this.pending();
    if (p.items.length) {
      const over = p.totalTokens > p.gateTokens;
      lines.push(`${p.items.length} rollup(s) pending, about ${p.totalTokens} tokens${over ? `, over the ${p.gateTokens} gate: ask the user before doing the ones marked needs_confirmation` : ""}. Call pending() for the list.`);
    }
    return lines.length ? `[Temporal Atlas checkpoint]\n${lines.join("\n")}` : undefined;
  }
}

export function newSessionId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join("");
}

export { GENERAL };
