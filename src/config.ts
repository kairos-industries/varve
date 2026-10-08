import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScrubPattern } from "./scrub/index.js";
import type { TimeConfig } from "./time/index.js";

export interface LengthTargets {
  segment: number;
  day: number;
  week: number;
  month: number;
  year: number;
}

export interface AtlasConfig extends TimeConfig {
  costGateTokens: number;
  lengthTargets: LengthTargets;
  briefTokens: { instructions: number; tool: number };
  scrubPatterns: ScrubPattern[];
  /** Orphan transcripts with less text than this are skipped as trivial. */
  orphanMinChars: number;
  /** Transcript text handed to a rollup is cut to this many characters. */
  transcriptMaxChars: number;
}

export const DEFAULT_CONFIG: AtlasConfig = {
  timezone: "local",
  dayBoundary: "04:00",
  costGateTokens: 30000,
  lengthTargets: { segment: 1500, day: 600, week: 500, month: 400, year: 800 },
  briefTokens: { instructions: 1500, tool: 5000 },
  scrubPatterns: [],
  orphanMinChars: 2000,
  transcriptMaxChars: 160000,
};

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
  };
}

/** Rough token estimate used for the cost gate and length targets. */
export function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}
