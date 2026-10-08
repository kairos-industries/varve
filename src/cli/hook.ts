import type { Atlas } from "../atlas.js";

export interface HookPayload {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
}

/** Handle one Claude Code hook call. */
export function runHook(atlas: Atlas, event: string, payload: HookPayload) {
  if (!payload.session_id && (event === "session-start" || event === "session-end")) {
    return { result: "skipped", reason: "no session_id in payload" };
  }
  const input = {
    sessionId: payload.session_id!,
    cwd: payload.cwd,
    transcriptPath: payload.transcript_path,
    client: "claude-code",
  };
  switch (event) {
    case "session-start":
      return { result: "registered", ...atlas.hookStart(input) };
    case "session-end":
      return atlas.hookEnd(input);
    default:
      throw new Error(`Unknown hook event "${event}". Use session-start or session-end.`);
  }
}
