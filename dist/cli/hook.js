/** Set for the `claude -p` runs that `varve tidy` starts, so their own hooks record nothing. The old name still counts. */
export const CHILD_ENV = "VARVE_CHILD";
const LEGACY_CHILD_ENV = "TEMPORAL_ATLAS_CHILD";
export const HOOK_EVENTS = ["session-start", "stop", "session-end"];
export const CLIENTS = ["claude-code", "codex"];
/** Handle one hook call from Claude Code or Codex, which send the same payload fields. */
export function runHook(atlas, event, payload, env = process.env, client = "claude-code") {
    if (!CLIENTS.includes(client))
        throw new Error(`Unknown client "${client}". Use ${CLIENTS.join(" or ")}.`);
    if (!HOOK_EVENTS.includes(event)) {
        throw new Error(`Unknown hook event "${event}". Use ${HOOK_EVENTS.join(", ")}.`);
    }
    if (env[CHILD_ENV] || env[LEGACY_CHILD_ENV])
        return { result: "skipped", reason: "a varve child process" };
    if (!payload.session_id)
        return { result: "skipped", reason: "no session_id in payload" };
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
