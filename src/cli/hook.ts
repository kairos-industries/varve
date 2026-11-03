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

export const CLIENTS = ["claude-code", "codex"] as const;

/** Handle one hook call from Claude Code or Codex, which send the same payload fields. */
export function runHook(atlas: Atlas, event: string, payload: HookPayload, env: NodeJS.ProcessEnv = process.env, client: string = "claude-code") {
  if (!(CLIENTS as readonly string[]).includes(client)) throw new Error(`Unknown client "${client}". Use ${CLIENTS.join(" or ")}.`);
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    throw new Error(`Unknown hook event "${event}". Use ${HOOK_EVENTS.join(", ")}.`);
  }
  if (env[CHILD_ENV]) return { result: "skipped", reason: "a temporal-atlas child process" };
  if (!payload.session_id) return { result: "skipped", reason: "no session_id in payload" };
  const input = {
    sessionId: payload.session_id,
    cwd: payload.cwd,
    transcriptPath: payload.transcript_path,
    client,
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
