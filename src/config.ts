import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ScrubPattern } from "./scrub/index.js";
import type { TimeConfig } from "./time/index.js";

export interface LengthTargets {
  segment: number;
  day: number;
  week: number;
  month: number;
  year: number;
}

export interface CaptureConfig {
  /** Record `claude -p` and other non-interactive sessions. Off by default: they are usually tools calling a model. */
  headless: boolean;
  /** Sessions whose working directory is inside one of these folders are not recorded by the hooks. */
  ignorePaths: string[];
  /** Sessions inside these folders belong to the general scope, whatever the folder is called. */
  generalPaths: string[];
}

export interface TidyConfig {
  /** The Claude Code CLI to run for each rollup. */
  command: string;
  model: string;
  /** Stop a run once this many input and output tokens have been used. */
  maxTokens: number;
  /** Stop a run once this many dollars have been spent, as `claude` reports it. */
  maxUsd: number;
  /** Local time for `install nightly`. */
  at: string;
}

export interface AtlasConfig extends TimeConfig {
  costGateTokens: number;
  lengthTargets: LengthTargets;
  briefTokens: { instructions: number; tool: number };
  scrubPatterns: ScrubPattern[];
  /** Transcript text handed to a rollup is cut to this many characters. */
  transcriptMaxChars: number;
  /** Who writes rollups: the connected agent, or the nightly `temporal-atlas tidy` run. */
  rollups: "agent" | "nightly";
  /** Mark every new scope isolated, so no project can read another's notes. For people who work for several clients. */
  isolateNewScopes: boolean;
  capture: CaptureConfig;
  tidy: TidyConfig;
  /** Blend meaning-based matches into search when the embedding model is installed (`temporal-atlas models pull`). */
  semanticSearch: boolean;
}

export const DEFAULT_CONFIG: AtlasConfig = {
  timezone: "local",
  dayBoundary: "04:00",
  costGateTokens: 30000,
  lengthTargets: { segment: 1500, day: 600, week: 500, month: 400, year: 800 },
  briefTokens: { instructions: 1500, tool: 5000 },
  scrubPatterns: [],
  transcriptMaxChars: 160000,
  rollups: "agent",
  isolateNewScopes: false,
  capture: {
    headless: false,
    ignorePaths: [],
    generalPaths: ["~/Library/Application Support/Claude", "~/.config/Claude", "~/AppData/Roaming/Claude"],
  },
  tidy: { command: "claude", model: "sonnet", maxTokens: 200000, maxUsd: 2, at: "04:30" },
  semanticSearch: true,
};

/** The keys `init` writes into a new atlas.config.json. */
export const INIT_KEYS = ["timezone", "dayBoundary", "costGateTokens", "lengthTargets", "briefTokens", "scrubPatterns", "rollups", "isolateNewScopes", "capture", "tidy"] as const;

export const CONFIG_FILE = "atlas.config.json";

export function loadConfig(dir: string, overrides: Partial<AtlasConfig> = {}): AtlasConfig {
  const path = join(dir, CONFIG_FILE);
  const fromFile: Partial<AtlasConfig> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...overrides,
    lengthTargets: { ...DEFAULT_CONFIG.lengthTargets, ...fromFile.lengthTargets, ...overrides.lengthTargets },
    briefTokens: { ...DEFAULT_CONFIG.briefTokens, ...fromFile.briefTokens, ...overrides.briefTokens },
    capture: { ...DEFAULT_CONFIG.capture, ...fromFile.capture, ...overrides.capture },
    tidy: { ...DEFAULT_CONFIG.tidy, ...fromFile.tidy, ...overrides.tidy },
  };
}

/** Rough token estimate used for the cost gate and length targets. */
export function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Expand a leading ~ and make the path absolute. */
export function expandHome(path: string): string {
  return resolve(path.replace(/^~(?=$|[\\/])/, homedir()));
}

/** True when `dir` is one of `roots` or inside one of them, with either path separator. */
export function isInside(dir: string, roots: string[]): boolean {
  const target = resolve(dir);
  return roots.map(expandHome).some((root) => {
    const rel = relative(root, target);
    return rel === "" || (rel.split(/[\\/]/)[0] !== ".." && !isAbsolute(rel));
  });
}
