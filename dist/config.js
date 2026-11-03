import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
export const DEFAULT_CONFIG = {
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
export const INIT_KEYS = ["timezone", "dayBoundary", "costGateTokens", "lengthTargets", "briefTokens", "scrubPatterns", "rollups", "isolateNewScopes", "capture", "tidy"];
export const CONFIG_FILE = "atlas.config.json";
export function loadConfig(dir, overrides = {}) {
    const path = join(dir, CONFIG_FILE);
    const fromFile = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
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
export function tokens(text) {
    return Math.ceil(text.length / 4);
}
/** Expand a leading ~ and make the path absolute. */
export function expandHome(path) {
    return resolve(path.replace(/^~(?=$|[\\/])/, homedir()));
}
/** True when `dir` is one of `roots` or inside one of them, with either path separator. */
export function isInside(dir, roots) {
    const target = resolve(dir);
    return roots.map(expandHome).some((root) => {
        const rel = relative(root, target);
        return rel === "" || (rel.split(/[\\/]/)[0] !== ".." && !isAbsolute(rel));
    });
}
