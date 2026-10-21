import type { Atlas } from "../atlas.js";

export interface HookPayload {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
}

/** Set for the `claude -p` runs that `temporal-atlas tidy` starts, so their own hooks record nothing. */
export const CHILD_ENV = "TEMPORAL_ATLAS_CHILD";

export const HOOK_EVENTS = ["session-start", "stop", "session-end"] as const;

/** Handle one Claude Code hook call. */
export function runHook(atlas: Atlas, event: string, payload: HookPayload, env: NodeJS.ProcessEnv = process.env) {
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    throw new Error(`Unknown hook event "${event}". Use ${HOOK_EVENTS.join(", ")}.`);
  }
  if (env[CHILD_ENV]) return { result: "skipped", reason: "a temporal-atlas child process" };
  if (!payload.session_id) return { result: "skipped", reason: "no session_id in payload" };
  const input = {
    sessionId: payload.session_id,
    cwd: payload.cwd,
    transcriptPath: payload.transcript_path,
    client: "claude-code",
  };
  switch (event) {
    case "session-start":
      return { result: "registered", ...atlas.hookStart(input) };
    case "stop":
      return atlas.capture(input);
    default:
      return atlas.hookEnd(input);
  }
}
