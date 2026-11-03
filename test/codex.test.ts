import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAsk, patchFiles } from "../src/capture/index.js";
import { runHook } from "../src/cli/hook.js";
import { type SetupDeps, setup, uninstall } from "../src/cli/setup.js";
import { transcriptText } from "../src/sessions/transcript.js";
import { setup as atlasSetup } from "./helpers.js";

type T = ReturnType<typeof atlasSetup>;

// Entries in the shape of a Codex rollout (codex-cli 0.166): finished items arrive as item_completed events.
const meta = (at: string, cwd: string, originator = "codex_cli_rs", thread_source = "user") => ({ timestamp: at, type: "session_meta", payload: { id: "th-1", cwd, originator, thread_source } });
const item = (at: string, it: object) => ({ timestamp: at, type: "event_msg", payload: { type: "item_completed", item: it } });
const ask = (at: string, text: string) => item(at, { type: "UserMessage", content: [{ type: "text", text }] });
const say = (at: string, text: string) => item(at, { type: "AgentMessage", content: [{ type: "Text", text }], phase: "final_answer" });
const run = (at: string, cmd: string) => item(at, { type: "CommandExecution", command: ["/bin/zsh", "-lc", cmd], aggregated_output: "COMMAND OUTPUT", status: "completed" });

function rollout(t: T) {
  const path = join(t.root, "rollout-2026-10-08T10-00-00-th-1.jsonl");
  writeFileSync(path, "");
  return { path, add: (...entries: object[]) => appendFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join("")) };
}

const sessions = (t: T, scope = "alpha") => t.files("scopes").filter((f) => f.startsWith(`scopes/${scope}/sessions/`));

describe("Codex capture", () => {
  it("records a Codex conversation from its rollout through the hooks", () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const cwd = t.cwd("alpha");
    const r = rollout(t);
    const payload = { session_id: "th-1", cwd, transcript_path: r.path };
    runHook(t.atlas, "session-start", payload, {}, "codex");
    r.add(
      meta("2026-10-08T08:00:00Z", cwd),
      { timestamp: "2026-10-08T08:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
      ask("2026-10-08T08:01:00Z", "Make the CSV export stream rows instead of building one string"),
      run("2026-10-08T08:02:00Z", "rg export src"),
      run("2026-10-08T08:03:00Z", "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/export.ts\n@@\n-old\n+new\n*** End Patch\nPATCH"),
      run("2026-10-08T08:05:00Z", 'git commit -am "Stream CSV export rows"'),
      say("2026-10-08T08:06:00Z", "Export now streams; memory stays flat on 1M rows."),
    );
    expect(runHook(t.atlas, "stop", payload, {}, "codex")).toMatchObject({ result: "captured" });
    const [file] = sessions(t);
    const text = t.read(file!);
    expect(text).toContain("client: codex");
    expect(text).toContain("10:01 asked: Make the CSV export stream rows instead of building one string");
    expect(text).toContain("files changed (1): `src/export.ts`");
    expect(text).toContain("10:05 commit: Stream CSV export rows");
    expect(text).toContain("10:06 last reply: Export now streams");
    expect(text).toContain("1 request, 3 tool calls");
    expect(text).not.toContain("COMMAND OUTPUT");
    expect(text).not.toContain("environment_context");

    expect(runHook(t.atlas, "session-end", payload, {}, "codex")).toMatchObject({ result: "closed" });
    expect(t.read(file!)).toContain("status: closed");
  });

  it("does not record codex exec runs or subagents", () => {
    for (const [originator, source] of [
      ["codex_exec", "user"],
      ["Codex Desktop", "subagent"],
    ]) {
      const t = atlasSetup("2026-10-08T10:00:00+02:00");
      const cwd = t.cwd("alpha");
      const r = rollout(t);
      r.add(meta("2026-10-08T08:00:00Z", cwd, originator, source), ask("2026-10-08T08:01:00Z", "Review the diff"));
      expect(runHook(t.atlas, "stop", { session_id: "th-1", cwd, transcript_path: r.path }, {}, "codex")).toMatchObject({ result: "skipped", reason: "headless" });
      expect(sessions(t)).toHaveLength(0);
    }
  });

  it("puts what the agent logs and what the hooks capture in one note", () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const cwd = t.cwd("alpha");
    const r = rollout(t);
    const payload = { session_id: "th-1", cwd, transcript_path: r.path };
    runHook(t.atlas, "session-start", payload, {}, "codex");
    // Codex starts the MCP server without a session id.
    const session = t.atlas.session({ cwd });
    r.add(meta("2026-10-08T08:00:00Z", cwd), ask("2026-10-08T08:01:00Z", "Pick a queue for invoice rendering"));
    session.log({ type: "decision", text: "Use SQS: already in the account, no new security review." });
    runHook(t.atlas, "stop", payload, {}, "codex");
    const files = sessions(t);
    expect(files).toHaveLength(1);
    const text = t.read(files[0]!);
    expect(text).toContain("Use SQS");
    expect(text).toContain("asked: Pick a queue for invoice rendering");
  });

  it("does not join a Codex conversation in another folder", () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const r = rollout(t);
    runHook(t.atlas, "session-start", { session_id: "th-1", cwd: t.cwd("alpha"), transcript_path: r.path }, {}, "codex");
    const session = t.atlas.session({ cwd: t.cwd("beta") });
    session.log({ type: "note", text: "beta work" });
    expect(session.scope).toBe("beta");
    expect(t.atlas.readRegistry()["th-1"]?.joined).toBeUndefined();
  });

  it("reads Codex rollouts as conversation text for orphan summaries", () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const r = rollout(t);
    r.add(meta("2026-10-08T08:00:00Z", t.cwd("alpha")), ask("2026-10-08T08:01:00Z", "What does the exporter do?"), run("2026-10-08T08:02:00Z", "cat x"), say("2026-10-08T08:03:00Z", "It writes CSV."));
    expect(transcriptText(r.path, 10_000)).toBe("User: What does the exporter do?\n\nAssistant: It writes CSV.");
  });

  it("keeps only the request from a message with attachments", () => {
    expect(codexAsk("\n# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\n\n## My request:\n\nWhy is this red?")).toBe("Why is this red?");
    expect(patchFiles("*** Begin Patch\n*** Add File: a.ts\n*** Delete File: b.ts\n*** End Patch")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("setup with Codex", () => {
  function deps(root: string, codex: string) {
    const home = join(root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other" }] }] } }));
    const calls: string[][] = [];
    const d: SetupDeps = {
      ask: async (_q, fallback) => fallback,
      exec: (command, args) => {
        calls.push([command, ...args]);
        return { ok: true, out: "" };
      },
      log: () => {},
      home,
      platform: "linux",
      claude: "",
      codex,
    };
    return { d, calls, hooks: () => JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")) };
  }

  it("installs the Codex hooks and registers the server, keeping other hooks", async () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const { d, calls, hooks } = deps(t.root, "/usr/local/bin/codex");
    await setup({ dir: t.dir, script: "/opt/atlas/dist/cli/main.js", yes: true }, d);
    const h = hooks().hooks;
    expect(h.UserPromptSubmit).toHaveLength(1);
    expect(h.Stop[0].hooks[0].command).toMatch(/hook stop --client codex$/);
    expect(h.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(calls).toContainEqual(expect.arrayContaining(["/usr/local/bin/codex", "mcp", "add", "varve"]));

    await uninstall({ dir: t.dir, script: "/opt/atlas/dist/cli/main.js", yes: true }, d);
    expect(Object.keys(hooks().hooks)).toEqual(["UserPromptSubmit"]);
  });

  it("installs the hooks when only the Codex folder exists (the desktop app)", async () => {
    const t = atlasSetup("2026-10-08T10:00:00+02:00");
    const { d, calls, hooks } = deps(t.root, "");
    await setup({ dir: t.dir, script: "/opt/atlas/dist/cli/main.js", yes: true }, d);
    expect(hooks().hooks.SessionStart[0].hooks[0].command).toContain("--client codex");
    expect(calls.filter((c) => c[0]!.includes("codex"))).toHaveLength(0);
  });
});
