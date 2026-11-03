import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The product's names. Varve was called Temporal Atlas until 0.5; the old command, environment
 * variables, folder and MCP registration keep working so existing installs need no change
 * (ADR 0009). The on-disk format keeps its names: atlas.config.json, .atlas/ and the `atlas:`
 * frontmatter key.
 */

export const NAME = "varve";
export const PRODUCT = "Varve";
export const LEGACY_NAME = "temporal-atlas";

/** An environment variable by its new name (VARVE_DIR), or its old one (TEMPORAL_ATLAS_DIR). */
export function envVar(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`VARVE_${suffix}`] || env[`TEMPORAL_ATLAS_${suffix}`] || undefined;
}

/** ~/Varve, or ~/TemporalAtlas when only the old folder exists. */
export function defaultDir(home: string): string {
  const current = join(home, PRODUCT);
  const legacy = join(home, "TemporalAtlas");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
