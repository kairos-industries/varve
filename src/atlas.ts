import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { absorb, type CaptureState, hasActivity, isHeadless, newCaptureState, readNewLines, renderActivity } from "./capture/index.js";
import { type AtlasConfig, isInside, loadConfig } from "./config.js";
import { scrub } from "./scrub/index.js";
import { buildBrief } from "./brief.js";
import { amend, type AmendInput, scanEdits } from "./edits.js";
import { search, type SearchOptions } from "./search.js";
import { mergeScope, rebuildIndexes } from "./scopes/manage.js";
import { applyRollupTopics, checkRollupTopics, type NamedTopicUpdate, topic, type TopicUpdate, topicScopes } from "./topics.js";
import { zoom } from "./zoom.js";
import { allScopes, markParentsStale, refreshAround, ScopeView } from "./periods.js";
import { pending, seal, type SealInput, summarize } from "./rollup/index.js";
import { canRead, type Detection, detectScope, GENERAL, readScopes, type ScopeRule, type ScopesFile, slug, writeScopes } from "./scopes/index.js";
import { parseSession, saveSession, segmentFor, type SessionNote } from "./sessions/note.js";
import { withMutex } from "./store/lock.js";
import { link, listMarkdown, readNote, writeFrontmatter } from "./store/note.js";
import { AtlasPaths } from "./store/paths.js";
import { type Clock, dayOf, systemClock, wallClock } from "./time/index.js";

export interface AtlasOptions {
  dir: string;
  clock?: Clock;
  config?: Partial<AtlasConfig>;
  /** New session ids; random unless given (the benchmark fixture needs the same names on every run). */
  sessionIds?: () => string;
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
  /** Why the hooks are not recording this session, e.g. "headless". */
  ignored?: string;
  /** Registry key of the MCP session that joined this hook session (Codex, which does not pass its session id to MCP servers). */
  joined?: string;
}

type Registry = Record<string, RegistryEntry>;

export class Atlas {
  readonly paths: AtlasPaths;
  readonly config: AtlasConfig;
  readonly clock: Clock;
  readonly newSessionId: () => string;

  constructor(opts: AtlasOptions) {
    this.paths = new AtlasPaths(opts.dir);
    this.config = loadConfig(opts.dir, opts.config);
    this.clock = opts.clock ?? systemClock;
    this.newSessionId = opts.sessionIds ?? newSessionId;
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

  /** Scope detection with this atlas's rules and general folders. */
  detect(cwd: string | undefined): Detection {
    return detectScope(cwd, this.scopes(), this.config.capture.generalPaths);
  }

  /** True when the hooks should not record sessions in this folder. */
  ignores(cwd: string | undefined): boolean {
    return Boolean(cwd) && isInside(cwd!, this.config.capture.ignorePaths);
  }

  /** Called before the first note of a scope is written: with isolateNewScopes, the new scope starts isolated. */
  claimScope(scope: string) {
    if (!this.config.isolateNewScopes || scope === GENERAL || existsSync(this.paths.scopeDir(scope))) return;
    const file = this.scopes();
    if (file.scopes[scope]) return;
    file.scopes[scope] = { isolated: true };
    writeScopes(this.paths.scopesFile, file);
  }

  /** Run `fn` holding the cross-process mutex for one note. The hooks and the MCP server both write session notes. */
  withNote<T>(path: string, fn: () => T): T {
    return withMutex(this.paths.noteMutex(path), fn);
  }

  // ---- hooks ----

  /** Capture progress for a client session, kept across restarts so a resumed conversation keeps its note. */
  readCapture(clientSessionId: string): CaptureState | undefined {
    const file = this.paths.captureFile(clientSessionId);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as CaptureState;
    } catch {
      return undefined;
    }
  }

  writeCapture(clientSessionId: string, state: CaptureState) {
    const file = this.paths.captureFile(clientSessionId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state));
  }

  /** The note an earlier start of this conversation wrote, if it is still there. */
  private knownNote(clientSessionId: string): { id: string; path: string; scope: string } | undefined {
    const state = this.readCapture(clientSessionId);
    if (!state?.noteId || !state.notePath || !existsSync(state.notePath)) return undefined;
    return { id: state.noteId, path: state.notePath, scope: String(readNote(state.notePath)!.fm.scope) };
  }

  hookStart(input: HookInput) {
    if (this.ignores(input.cwd)) return { scope: undefined, ignored: "ignorePaths" };
    const known = this.knownNote(input.sessionId);
    const scope = known?.scope ?? this.detect(input.cwd).scope;
    pruneCaptures(this.paths.captureDir, this.now());
    this.updateRegistry((reg) => {
      const prev = reg[input.sessionId];
      reg[input.sessionId] = {
        ...prev,
        id: prev?.id ?? known?.id ?? this.newSessionId(),
        path: prev?.path ?? known?.path,
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

  /**
   * Stop hook (after every turn) and SessionEnd: read what the transcript gained since the
   * last call and rewrite the session's Activity sections. No model is involved.
   */
  capture(input: HookInput): CaptureResult {
    if (this.ignores(input.cwd)) return { result: "skipped", reason: "ignorePaths" };
    const known = this.knownNote(input.sessionId);
    const entry = this.updateRegistry((reg) => {
      const prev = reg[input.sessionId];
      reg[input.sessionId] = {
        ...prev,
        id: prev?.id ?? known?.id ?? this.newSessionId(),
        path: prev?.path ?? known?.path,
        scope: prev?.scope ?? known?.scope ?? this.detect(input.cwd).scope,
        cwd: prev?.cwd ?? input.cwd,
        clientSessionId: input.sessionId,
        client: prev?.client ?? input.client ?? "claude-code",
        transcript: input.transcriptPath ?? prev?.transcript,
        startedAt: prev?.startedAt ?? this.stamp(),
      };
      return { ...reg[input.sessionId]! };
    });
    if (entry.ignored) return { result: "skipped", reason: entry.ignored };
    const transcript = entry.transcript;
    if (!transcript) return { result: "skipped", reason: "no transcript" };

    const state = this.readCapture(input.sessionId) ?? newCaptureState();
    const { lines, offset } = readNewLines(transcript, state.offset);
    if (offset < state.offset) Object.assign(state, { ...newCaptureState(), noteId: state.noteId, notePath: state.notePath });
    state.cwd ??= entry.cwd;
    absorb(state, lines, this.config);
    state.offset = offset;
    this.writeCapture(input.sessionId, state);

    if (isHeadless(state) && !this.config.capture.headless) {
      this.updateRegistry((reg) => {
        if (reg[input.sessionId]) reg[input.sessionId]!.ignored = "headless";
      });
      return { result: "skipped", reason: "headless" };
    }
    if (!hasActivity(state)) return { result: "waiting" };
    if (!lines.length && entry.path && existsSync(entry.path)) return { result: "unchanged", path: entry.path };
    const out = this.writeActivity(entry, state);
    if (out.path && (state.notePath !== out.path || state.noteId !== entry.id)) {
      this.writeCapture(input.sessionId, { ...state, noteId: entry.id, notePath: out.path });
    }
    return out;
  }

  /** Write the capture state into the session note, creating the note on the first turn. */
  writeActivity(entry: RegistryEntry, state: CaptureState): CaptureResult {
    let path = entry.path && existsSync(entry.path) ? entry.path : undefined;
    const det = this.detect(entry.cwd ?? state.cwd);
    const scope = path ? String(readNote(path)!.fm.scope) : (entry.scope ?? det.scope);
    if (!path) {
      const { date, time } = wallClock(new Date(entry.startedAt), this.config);
      path = this.paths.sessionNote(scope, date, time, entry.id);
      this.claimScope(scope);
    }
    const notePath = path;
    const changed: string[] = [];
    this.withNote(notePath, () => {
      const existing = readNote(notePath);
      const s: SessionNote = existing
        ? parseSession(existing)
        : {
            path: notePath,
            fm: {
              atlas: "session",
              scope,
              session: entry.id,
              started: entry.startedAt,
              status: "open",
              client: entry.client,
              client_session_id: entry.clientSessionId,
              transcript: entry.transcript,
              ...originFields(det, entry.cwd ?? state.cwd),
            },
            segments: [],
          };
      for (const day of Object.keys(state.days).sort()) {
        const text = renderActivity(state, day);
        if (!text) continue;
        const seg = segmentFor(s, day);
        const scrubbed = this.scrub(text);
        if (seg.activity !== scrubbed) {
          seg.activity = scrubbed;
          changed.push(day);
        }
      }
      if (state.title) s.fm.title = this.scrub(state.title);
      s.fm.transcript ??= entry.transcript;
      if (changed.length && s.fm.status === "closed") {
        s.fm.status = "open";
        delete s.fm.ended;
      }
      if (changed.length || !existing) saveSession(s);
    });
    this.updateRegistry((reg) => {
      const e = reg[entry.clientSessionId ?? ""];
      if (e) e.path = notePath;
    });
    const stale = this.markDaysStale(scope, changed);
    return { result: "captured", path: notePath, days: changed, nowStale: stale };
  }

  /** A sealed day whose sessions changed needs its rollup redone. */
  markDaysStale(scope: string, days: string[]): string[] {
    const view = new ScopeView(this, scope);
    const stale: string[] = [];
    for (const day of days) {
      const n = view.note(day);
      if (n?.fm.status === "sealed") {
        writeFrontmatter(n, { status: "stale" });
        stale.push(day, ...markParentsStale(this, scope, day));
      }
    }
    return stale;
  }

  hookEnd(input: HookInput) {
    const captured = this.capture(input);
    const entry = this.updateRegistry((reg) => {
      const e = reg[input.sessionId];
      delete reg[input.sessionId];
      return e;
    });
    const path = captured.path ?? entry?.path;
    if (!path || !existsSync(path)) return { result: "skipped", reason: captured.reason ?? "nothing to record" };
    const s = this.withNote(path, () => {
      const note = parseSession(readNote(path)!);
      note.fm.status = "closed";
      note.fm.ended = this.stamp();
      const transcript = input.transcriptPath ?? entry?.transcript;
      if (transcript) note.fm.transcript = transcript;
      saveSession(note);
      return note;
    });
    refreshAround(this, String(s.fm.scope), s.segments.map((x) => x.day));
    return { result: "closed", path };
  }
}

export interface CaptureResult {
  result: "captured" | "unchanged" | "waiting" | "skipped";
  reason?: string;
  path?: string;
  days?: string[];
  nowStale?: string[];
}

function originFields(det: Detection, cwd: string | undefined) {
  if (det.remote) return { origin: det.remote, origin_kind: "remote" };
  const path = det.gitRoot ?? cwd;
  return path ? { origin: path, origin_kind: "path" } : {};
}

const USAGE = `Varve is your memory of past work, layered by time: sessions, days, weeks, months, years. The current scope is "{scope}".
- During work, call log for each decision (with the reason), notable change, finding or todo.
- If this session's work belongs to a different client or project than "{scope}", call log with scope set to that project's name; the session moves there. Keep each client's work in its own scope.
- Before you finish, call close_session with a one-line headline and a summary using ### Done, ### Decisions, ### Open threads.
{rollups}
- For more history: brief (wider view), zoom (open any period or session), search (keywords), topic (durable knowledge).
`;

const AGENT_ROLLUPS = "- If a tool result reports pending rollups, work through them with summarize and seal. Past the cost gate, ask the user first.";
const NIGHTLY_ROLLUPS = "- Rollups run overnight (varve tidy). Do them with summarize and seal only when the user asks.";

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
/** How far apart a Codex hook session and an MCP server may start and still be taken for one conversation. */
const JOIN_WINDOW_MS = 5 * 60 * 1000;
const CAPTURE_TTL_MS = 60 * 24 * 3600 * 1000;

/** Forget capture progress for conversations untouched for 60 days. */
function pruneCaptures(dir: string, now: Date) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    try {
      if (now.getTime() - statSync(full).mtimeMs > CAPTURE_TTL_MS) rmSync(full, { force: true });
    } catch {
      // gone already
    }
  }
}

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
  id: string;
  readonly started: Date;
  scope: string;
  private key: string;
  private path?: string;
  private scopeLocked = false;
  private cwd?: string;
  private transcript?: string;
  private readonly client?: string;
  private clientSessionId?: string;
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
    this.id = fromHook?.id ?? atlas.newSessionId();
    this.cwd = opts.cwd ?? fromHook?.cwd;
    this.transcript = opts.transcript ?? fromHook?.transcript;
    const det = atlas.detect(this.cwd);
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
    this.joinCodex();
  }

  /**
   * Codex starts its MCP servers without saying which conversation they serve. Join the Codex
   * hook session that started in the same folder at about the same time, so what the agent logs
   * and what the hooks capture land in one note. Two Codex conversations started together in one
   * folder can be paired the wrong way round.
   */
  private joinCodex() {
    if (this.clientSessionId || this.path || !this.cwd) return;
    const mine = this.key;
    const peer = this.atlas.updateRegistry((reg) => {
      const found = Object.entries(reg)
        .filter(([, e]) => e.client === "codex" && !e.joined && e.cwd === this.cwd && !e.ignored)
        .filter(([, e]) => Math.abs(new Date(e.startedAt).getTime() - this.started.getTime()) <= JOIN_WINDOW_MS)
        .sort(([, a], [, b]) => b.startedAt.localeCompare(a.startedAt))[0];
      if (!found) return undefined;
      const [key, e] = found;
      e.joined = mine;
      delete reg[mine];
      return { key, entry: { ...e } };
    });
    if (!peer) return;
    this.key = peer.key;
    this.clientSessionId = peer.key;
    this.id = peer.entry.id;
    this.transcript ??= peer.entry.transcript;
    if (peer.entry.scope) this.scope = peer.entry.scope;
  }

  get notePath(): string | undefined {
    return this.path;
  }

  /** Adopt a note the capture hook created after this server started. */
  private adoptHookNote() {
    if (this.path) return;
    this.joinCodex();
    const p = this.atlas.readRegistry()[this.key]?.path;
    if (!p || !existsSync(p)) return;
    this.path = p;
    this.scope = String(readNote(p)!.fm.scope ?? this.scope);
    this.scopeLocked = true;
  }

  /** The session note's path, choosing it on first write. */
  private ensurePath(): string {
    this.adoptHookNote();
    if (this.path) return this.path;
    const { date, time } = wallClock(this.started, this.atlas.config);
    this.atlas.claimScope(this.scope);
    const path = this.atlas.paths.sessionNote(this.scope, date, time, this.id);
    this.path = path;
    this.scopeLocked = true;
    this.atlas.updateRegistry((reg) => {
      if (reg[this.key]) reg[this.key]!.path = path;
    });
    return path;
  }

  /** Read, change and save the session note under the note mutex. */
  private mutate<T>(fn: (s: SessionNote) => T): T {
    const path = this.ensurePath();
    return this.atlas.withNote(path, () => {
      const note = readNote(path);
      const s: SessionNote = note
        ? parseSession(note)
        : {
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
      const out = fn(s);
      saveSession(s);
      return out;
    });
  }

  log(input: LogInput) {
    this.adoptHookNote();
    if (input.scope && !this.scopeLocked) {
      this.scope = slug(input.scope);
      this.atlas.updateRegistry((reg) => {
        if (reg[this.key]) reg[this.key]!.scope = this.scope;
      });
    } else if (input.scope && slug(input.scope) !== this.scope) {
      this.moveTo(slug(input.scope));
    }
    const now = this.atlas.now();
    const event = {
      time: wallClock(now, this.atlas.config).time,
      type: slug(input.type).replace(/-/g, "") || "note",
      text: this.atlas.scrub(input.text.replace(/\s*\n\s*/g, " ").trim()),
      topics: (input.topics ?? []).map((t) => t.trim()).filter(Boolean),
    };
    const day = this.mutate((s) => {
      const seg = segmentFor(s, dayOf(now, this.atlas.config));
      seg.events.push(event);
      s.fm.status = "open";
      delete s.fm.ended;
      return seg.day;
    });
    return { session: this.id, scope: this.scope, day, event };
  }

  /** Move this session's note to another scope, for work done in one folder that belongs to a different client or project. */
  private moveTo(target: string) {
    const from = this.scope;
    const oldPath = this.path;
    if (!oldPath || !existsSync(oldPath)) {
      this.scope = target;
      this.path = undefined;
      this.atlas.updateRegistry((reg) => {
        if (reg[this.key]) Object.assign(reg[this.key]!, { scope: target, path: undefined });
      });
      return;
    }
    this.atlas.claimScope(target);
    const newPath = join(this.atlas.paths.sessionsDir(target), oldPath.slice(this.atlas.paths.sessionsDir(from).length + 1));
    const days = this.atlas.withNote(oldPath, () => {
      const s = parseSession(readNote(oldPath)!);
      saveSession({ ...s, path: newPath, fm: { ...s.fm, scope: target, moved_from: from } });
      rmSync(oldPath);
      return s.segments.map((x) => x.day);
    });
    this.path = newPath;
    this.scope = target;
    this.atlas.updateRegistry((reg) => {
      if (reg[this.key]) Object.assign(reg[this.key]!, { scope: target, path: newPath });
    });
    if (this.clientSessionId) {
      const state = this.atlas.readCapture(this.clientSessionId);
      if (state) this.atlas.writeCapture(this.clientSessionId, { ...state, notePath: newPath });
    }
    this.atlas.markDaysStale(from, days);
    refreshAround(this.atlas, from, days);
    refreshAround(this.atlas, target, days);
  }

  closeSession(input: CloseInput) {
    const today = dayOf(this.atlas.now(), this.atlas.config);
    const day = input.segment ?? today;
    const days = this.mutate((s) => {
      const seg = segmentFor(s, day);
      seg.headline = this.atlas.scrub(input.headline.replace(/\s*\n\s*/g, " ").trim());
      seg.summary = this.atlas.scrub(demoteHeadings(input.summary.trim()));
      if (day === today) {
        s.fm.status = "closed";
        s.fm.ended = this.atlas.stamp();
      }
      return s.segments.map((x) => x.day);
    });
    refreshAround(this.atlas, this.scope, days);
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
    const usage = USAGE.replace("{scope}", this.scope).replace("{rollups}", this.atlas.config.rollups === "nightly" ? NIGHTLY_ROLLUPS : AGENT_ROLLUPS);
    const cap = this.atlas.config.briefTokens.instructions - Math.ceil(usage.length / 4);
    const brief = buildBrief(this.atlas, { scope: this.scope, visible: this.visibleScopes(), compact: true, capTokens: cap });
    return `${usage}\n${brief}`;
  }

  zoom(input: { period: string; scope?: string }) {
    return zoom(this.atlas, this.resolveScope(input.scope), input.period);
  }

  search(input: { query: string; scope?: string; layer?: string; from?: string; to?: string; limit?: number }, opts?: SearchOptions) {
    const scopes = input.scope ? [this.resolveScope(input.scope)] : this.visibleScopes();
    return search(this.atlas, { ...input, scopes }, opts);
  }

  amend(input: AmendInput & { scope?: string }) {
    return amend(this.atlas, this.resolveScope(input.scope), input);
  }

  /** Called when the client disconnects. */
  disconnect() {
    this.adoptHookNote();
    const path = this.path;
    if (!path) return;
    const days = this.atlas.withNote(path, () => {
      const note = readNote(path);
      if (!note || note.fm.status === "closed") return undefined;
      const s = parseSession(note);
      s.fm.status = "closed";
      s.fm.ended = this.atlas.stamp();
      saveSession(s);
      return s.segments.map((x) => x.day);
    });
    if (days) refreshAround(this.atlas, this.scope, days);
  }

  summarize(input: { period: string; scope?: string; confirmed?: boolean }) {
    return summarize(this.atlas, this.key, this.resolveScope(input.scope), input.period, input.confirmed);
  }

  seal(input: SealInput & { scope?: string; topicUpdates?: NamedTopicUpdate[] }) {
    const scope = this.resolveScope(input.scope);
    const updates = input.topicUpdates ?? [];
    checkRollupTopics(this.atlas, scope, input.period, updates);
    const result = seal(this.atlas, this.key, scope, input);
    const topics = applyRollupTopics(this.atlas, scope, input.period, link(result.path), updates);
    return { ...result, topics: topics.map((x) => (x.changes?.length ? `${x.name} (${x.changes.join(", ")})` : x.name)) };
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
        const det = this.atlas.detect(this.cwd);
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
    this.adoptHookNote();
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
    if (p.items.length && this.atlas.config.rollups === "agent") {
      const over = p.totalTokens > p.gateTokens;
      lines.push(`${p.items.length} rollup(s) pending, about ${p.totalTokens} tokens${over ? `, over the ${p.gateTokens} gate: ask the user before doing the ones marked needs_confirmation` : ""}. Call pending() for the list.`);
    }
    return lines.length ? `[Varve checkpoint]\n${lines.join("\n")}` : undefined;
  }
}

/** Headings inside a session summary sit below the note's own ### sections. */
function demoteHeadings(md: string): string {
  return md.replace(/^#{1,3} /gm, "#### ");
}

export function newSessionId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join("");
}

export { GENERAL };
