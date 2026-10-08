import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type AtlasConfig, loadConfig } from "./config.js";
import { scrub } from "./scrub/index.js";
import { detectScope, GENERAL, readScopes, type ScopesFile, slug } from "./scopes/index.js";
import {
  parseSession,
  saveSession,
  type Segment,
  type SessionNote,
} from "./sessions/note.js";
import { withMutex } from "./store/lock.js";
import { listMarkdown, readNote } from "./store/note.js";
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

  constructor(
    readonly atlas: Atlas,
    opts: SessionOptions,
  ) {
    this.started = atlas.now();
    this.clientSessionId = opts.clientSessionId;
    this.client = opts.client;
    this.key = opts.clientSessionId ?? `mcp-${randomBytes(6).toString("hex")}`;
    const fromHook = opts.clientSessionId ? atlas.readRegistry()[opts.clientSessionId] : undefined;
    this.id = fromHook?.id ?? randomId();
    this.cwd = opts.cwd ?? fromHook?.cwd;
    this.transcript = opts.transcript ?? fromHook?.transcript;
    this.scope = fromHook?.scope ?? detectScope(this.cwd, atlas.scopes()).scope;
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
    return { session: this.id, scope: this.scope, segment: day, closed: day === today };
  }
}

function randomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join("");
}

export { GENERAL };
