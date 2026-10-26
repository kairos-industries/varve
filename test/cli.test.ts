import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/cli/doctor.js";
import { ATLAS_HOOK, hookCommand, mergeHooks } from "../src/cli/install.js";
import { runHook } from "../src/cli/hook.js";
import { findOnPath } from "../src/cli/nightly.js";
import { setup } from "./helpers.js";

const CMD = "temporal-atlas hook";

describe("install claude-code", () => {
  it("adds SessionStart and SessionEnd hooks and keeps existing ones", () => {
    const existing = { model: "opus", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } };
    const merged = mergeHooks(existing, CMD) as unknown as { model: string; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(merged.model).toBe("opus");
    expect(merged.hooks.SessionStart!.map((h) => h.hooks[0]!.command)).toEqual(["echo hi", `${CMD} session-start`]);
    expect(merged.hooks.SessionEnd!.map((h) => h.hooks[0]!.command)).toEqual([`${CMD} session-end`]);
    expect(merged.hooks.Stop!.map((h) => h.hooks[0]!.command)).toEqual([`${CMD} stop`]);
  });

  it("is idempotent and replaces an older atlas hook command", () => {
    const once = mergeHooks({}, "old/path/temporal-atlas hook");
    const twice = mergeHooks(once, CMD) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(twice.hooks.SessionStart!.map((h) => h.hooks[0]!.command)).toEqual([`${CMD} session-start`]);
  });

  it("passes the atlas folder as --dir, with forward slashes on Windows, and replaces the older env-prefix hooks", () => {
    expect(hookCommand("/Users/me/Atlas", "/g/lib/node_modules/temporal-atlas/dist/cli/main.js", "darwin")).toBe(
      'node "/g/lib/node_modules/temporal-atlas/dist/cli/main.js" --dir "/Users/me/Atlas" hook',
    );
    const win = hookCommand("C:\\Users\\me\\TemporalAtlas", "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\temporal-atlas\\dist\\cli\\main.js", "win32");
    expect(win).toBe('node "C:/Users/me/AppData/Roaming/npm/node_modules/temporal-atlas/dist/cli/main.js" --dir "C:/Users/me/TemporalAtlas" hook');
    expect(win).not.toContain("TEMPORAL_ATLAS_DIR=");

    const old = mergeHooks({}, 'TEMPORAL_ATLAS_DIR="/Users/me/Atlas" node "/repo/dist/cli/main.js" hook');
    const updated = mergeHooks(old, hookCommand("/Users/me/Atlas", "/repo/dist/cli/main.js", "darwin")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(updated.hooks.Stop!.map((h) => h.hooks[0]!.command)).toEqual(['node "/repo/dist/cli/main.js" --dir "/Users/me/Atlas" hook stop']);
    expect(ATLAS_HOOK.test("python3 ~/.claude/obsidian/capture.py stop")).toBe(false);
  });

  it("finds claude.cmd on PATH on Windows, and only the exact name elsewhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-path-"));
    writeFileSync(join(dir, "claude.cmd"), "");
    expect(findOnPath("claude", dir, "win32")?.toLowerCase()).toBe(join(dir, "claude.cmd").toLowerCase());
    expect(findOnPath("claude", dir, "linux")).toBeUndefined();
  });
});

describe("hook command", () => {
  it("passes the Claude Code payload to the atlas", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    runHook(t.atlas, "session-start", { session_id: "abc", cwd: t.cwd("alpha"), transcript_path: "/tmp/x.jsonl", hook_event_name: "SessionStart" });
    const s = t.atlas.session({ clientSessionId: "abc" });
    expect(s.scope).toBe("alpha");
    expect(runHook(t.atlas, "session-end", { session_id: "abc", cwd: t.cwd("alpha") })).toMatchObject({ result: "skipped" });
  });

  it("rejects unknown events", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    expect(() => runHook(t.atlas, "bogus", {})).toThrow(/session-start/);
  });
});

describe("doctor", () => {
  it("reports pending rollups, open sessions left behind and unresolved links", () => {
    const t = setup("2026-10-01T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("alpha") }).log({ type: "note", text: "left open", topics: ["Ghost topic"] });
    t.at("2026-10-08T10:00:00+02:00");
    const r = doctor(t.atlas);
    expect(r.scopes).toEqual(["alpha"]);
    expect(r.pending.find((p) => p.scope === "alpha")?.count).toBeGreaterThan(0);
    expect(r.openSessions).toHaveLength(1);
    expect(r.unresolvedLinks).toContain("Ghost topic");
    expect(r.problems).toEqual([]);
  });

  it("flags notes whose frontmatter does not parse", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("alpha") }).closeSession({ headline: "x", summary: "y" });
    const path = "scopes/alpha/days/2026/2026-10-08 alpha.md";
    t.write(path, "---\nstatus: [unclosed\n---\nbody\n");
    expect(doctor(t.atlas).problems.join("\n")).toContain("2026-10-08 alpha.md");
  });
});
