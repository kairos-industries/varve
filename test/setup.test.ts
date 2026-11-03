import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Atlas } from "../src/atlas.js";
import { type SetupDeps, setup, uninstall } from "../src/cli/setup.js";
import { setup as atlasSetup } from "./helpers.js";

function fakeDeps(root: string, answers: boolean[] = []) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "python3 other.py" }] }] } }));
  const deps: SetupDeps = {
    ask: async (_q, fallback) => answers.shift() ?? fallback,
    exec: (command, args) => {
      calls.push([command, ...args]);
      return { ok: true, out: "" };
    },
    log: (l) => lines.push(l),
    home,
    platform: "linux",
    claude: "/usr/local/bin/claude",
    codex: "",
  };
  return { deps, calls, lines, settings: () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) };
}

describe("setup", () => {
  it("creates the atlas, registers the server, installs the hooks and isolates projects", async () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const dir = join(t.root, "Atlas");
    const f = fakeDeps(t.root);
    expect(await setup({ dir, script: "/repo/dist/cli/main.js", yes: true }, f.deps)).toBe(true);

    const config = JSON.parse(readFileSync(join(dir, "atlas.config.json"), "utf8"));
    expect(config.isolateNewScopes).toBe(true);
    const add = f.calls.find((c) => c[2] === "add")!;
    expect(add).toEqual(["/usr/local/bin/claude", "mcp", "add", "temporal-atlas", "--scope", "user", "-e", `TEMPORAL_ATLAS_DIR=${dir}`, "--", process.execPath, "/repo/dist/cli/main.js"]);
    const s = f.settings();
    expect(s.model).toBe("opus");
    expect(Object.keys(s.hooks).sort()).toEqual(["SessionEnd", "SessionStart", "Stop"]);
    expect(s.hooks.SessionEnd).toHaveLength(2);
    expect(f.lines.join("\n")).not.toMatch(/crontab/);
  });

  it("asks before changing anything and stops on no", async () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const dir = join(t.root, "Atlas");
    const f = fakeDeps(t.root, [false]);
    expect(await setup({ dir, script: "/repo/dist/cli/main.js", yes: false }, f.deps)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("schedules the nightly run only when asked", async () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const f = fakeDeps(t.root, [true, false, true]);
    await setup({ dir: join(t.root, "Atlas"), script: "/repo/dist/cli/main.js", yes: false }, f.deps);
    expect(JSON.parse(readFileSync(join(t.root, "Atlas", "atlas.config.json"), "utf8")).isolateNewScopes).toBe(false);
    expect(f.lines.join("\n")).toMatch(/crontab/);
  });

  it("uninstalls the hooks and the server and keeps the notes", async () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const dir = join(t.root, "Atlas");
    const f = fakeDeps(t.root);
    await setup({ dir, script: "/repo/dist/cli/main.js", yes: true }, f.deps);
    await uninstall({ dir, script: "/repo/dist/cli/main.js", yes: true }, f.deps);
    const s = f.settings();
    expect(s.hooks).toEqual({ SessionEnd: [{ hooks: [{ type: "command", command: "python3 other.py" }] }] });
    expect(f.calls.filter((c) => c[2] === "remove").length).toBeGreaterThan(1);
    expect(existsSync(join(dir, "atlas.config.json"))).toBe(true);
  });
});

describe("client isolation", () => {
  it("starts every new project isolated when isolateNewScopes is on", () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const atlas = new Atlas({ dir: t.dir, clock: () => new Date("2026-10-08T10:00:00+02:00"), config: { timezone: "Europe/Madrid", isolateNewScopes: true } });
    atlas.session({ cwd: t.cwd("alpha") }).closeSession({ headline: "Alpha work", summary: "x" });
    atlas.session({ cwd: t.cwd("client-x") }).closeSession({ headline: "Client X work", summary: "y" });
    expect(atlas.scopes().scopes).toEqual({ alpha: { isolated: true }, "client-x": { isolated: true } });
    expect(atlas.session({ cwd: t.cwd("alpha") }).brief()).not.toContain("Client X work");
  });

  it("moves a session to another project when the agent names it, and the hook follows", () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const tr = join(t.root, "t.jsonl");
    const line = (at: string, text: string) => `${JSON.stringify({ type: "user", timestamp: at, turnOrigin: "human", message: { content: text } })}\n`;
    writeFileSync(tr, line("2026-10-08T08:01:00Z", "Prepare the client-x workshop deck"));
    t.atlas.hookStart({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr });
    t.atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha") });
    expect(t.files("scopes")[0]).toMatch(/^scopes\/alpha\//);

    const mcp = t.atlas.session({ clientSessionId: "cc-1" });
    mcp.log({ type: "note", text: "This is client-x work", scope: "client-x" });
    appendFileSync(tr, line("2026-10-08T08:30:00Z", "Now the speaker notes"));
    t.atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha") });

    const files = t.files("scopes").filter((f) => f.includes("/sessions/"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^scopes\/client-x\//);
    const text = t.read(files[0]!);
    expect(text).toContain("moved_from: alpha");
    expect(text).toContain("asked: Prepare the client-x workshop deck");
    expect(text).toContain("asked: Now the speaker notes");
    expect(text).toContain("note: This is client-x work");
  });
});
