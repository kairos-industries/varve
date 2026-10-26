import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askText, milestone } from "../src/capture/index.js";
import { runHook } from "../src/cli/hook.js";
import { backfill } from "../src/cli/backfill.js";
import { setup } from "./helpers.js";

type T = ReturnType<typeof setup>;

const user = (at: string, text: string, origin = "human") => ({ type: "user", timestamp: at, turnOrigin: origin, message: { role: "user", content: text } });
const reply = (at: string, text: string) => ({ type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (at: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  timestamp: at,
  message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
});
const result = (at: string) => ({ type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", content: "TOOL OUTPUT" }] } });

function transcriptFile(t: T, name = "t.jsonl") {
  const path = join(t.root, name);
  writeFileSync(path, "");
  return {
    path,
    add: (...entries: object[]) => appendFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join("")),
  };
}

function onlySession(t: T, scope = "alpha") {
  const files = t.files("scopes").filter((f) => f.startsWith(`scopes/${scope}/sessions/`));
  expect(files).toHaveLength(1);
  return t.read(files[0]!);
}

describe("activity capture from the transcript", () => {
  it("builds the session record turn by turn, with no model and no agent call", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const tr = transcriptFile(t);
    const cwd = t.cwd("alpha");
    t.atlas.hookStart({ sessionId: "cc-1", cwd, transcriptPath: tr.path });

    tr.add({ type: "ai-title", aiTitle: "Billing export refactor" }, user("2026-10-08T08:01:00Z", "Refactor the billing export into its own module"), reply("2026-10-08T08:02:00Z", "Looking at it."));
    expect(t.atlas.capture({ sessionId: "cc-1", cwd })).toMatchObject({ result: "captured" });
    let text = onlySession(t);
    expect(text).toContain("### Activity");
    expect(text).toContain("Billing export refactor");
    expect(text).toContain("10:01 asked: Refactor the billing export into its own module");

    tr.add(
      tool("2026-10-08T08:10:00Z", "Edit", { file_path: join(cwd, "src/export.ts") }),
      result("2026-10-08T08:10:01Z"),
      tool("2026-10-08T08:20:00Z", "Bash", { command: 'git commit -am "Split the billing exporter"' }),
      result("2026-10-08T08:20:01Z"),
      reply("2026-10-08T08:21:00Z", "Done: exporter split, tests pass."),
    );
    t.atlas.capture({ sessionId: "cc-1", cwd });
    text = onlySession(t);
    expect(text).toContain("files changed (1): `src/export.ts`");
    expect(text).toContain("10:20 commit: Split the billing exporter");
    expect(text).toContain("10:21 last reply: Done: exporter split, tests pass.");
    expect(text).not.toContain("TOOL OUTPUT");

    expect(t.atlas.capture({ sessionId: "cc-1", cwd })).toMatchObject({ result: "unchanged" });
  });

  it("splits activity at the day boundary", () => {
    const t = setup("2026-10-07T22:00:00+02:00");
    const tr = transcriptFile(t);
    tr.add(user("2026-10-07T21:00:00Z", "evening ask"), user("2026-10-08T01:30:00Z", "still the 7th"), user("2026-10-08T07:00:00Z", "next morning"));
    t.atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr.path });
    const text = onlySession(t);
    const eighth = text.indexOf("## 2026-10-08");
    expect(text.indexOf("still the 7th")).toBeLessThan(eighth);
    expect(text.indexOf("next morning")).toBeGreaterThan(eighth);
  });

  it("does not record headless runs such as claude -p", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const tr = transcriptFile(t);
    tr.add(user("2026-10-08T08:00:00Z", "<transcript>...</transcript> Summarize this session", "sdk"), reply("2026-10-08T08:00:05Z", "Summary."));
    expect(t.atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr.path })).toMatchObject({ result: "skipped", reason: "headless" });
    expect(t.atlas.hookEnd({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr.path })).toMatchObject({ result: "skipped" });
    expect(t.files("scopes")).toEqual([]);
  });

  it("records headless runs when capture.headless is on", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const atlas = new (t.atlas.constructor as typeof import("../src/atlas.js").Atlas)({ dir: t.dir, clock: () => new Date("2026-10-08T10:00:00+02:00"), config: { timezone: "Europe/Madrid", capture: { headless: true, ignorePaths: [], generalPaths: [] } } });
    const tr = transcriptFile(t);
    tr.add(user("2026-10-08T08:00:00Z", "nightly report", "sdk"));
    expect(atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr.path })).toMatchObject({ result: "captured" });
  });

  it("ignores folders in capture.ignorePaths and sends generalPaths to general", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const Atlas = t.atlas.constructor as typeof import("../src/atlas.js").Atlas;
    const atlas = new Atlas({
      dir: t.dir,
      clock: () => new Date("2026-10-08T10:00:00+02:00"),
      config: { timezone: "Europe/Madrid", capture: { headless: false, ignorePaths: [t.cwd("beta")], generalPaths: [t.cwd("client-x")] } },
    });
    const tr = transcriptFile(t);
    tr.add(user("2026-10-08T08:00:00Z", "hello"));
    expect(atlas.capture({ sessionId: "cc-1", cwd: t.cwd("beta"), transcriptPath: tr.path })).toMatchObject({ result: "skipped", reason: "ignorePaths" });
    atlas.hookStart({ sessionId: "cc-2", cwd: t.cwd("client-x"), transcriptPath: tr.path });
    atlas.capture({ sessionId: "cc-2", cwd: t.cwd("client-x") });
    expect(t.files("scopes").every((f) => f.startsWith("scopes/general/"))).toBe(true);
  });

  it("shares one note with the MCP session of the same conversation", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const tr = transcriptFile(t);
    t.atlas.hookStart({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr.path });
    const mcp = t.atlas.session({ clientSessionId: "cc-1" });
    tr.add(user("2026-10-08T08:01:00Z", "Plan the export"));
    t.atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha") });
    mcp.log({ type: "decision", text: "CSV first, because finance asked for it" });
    tr.add(user("2026-10-08T08:30:00Z", "Now write it"));
    t.atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha") });
    mcp.closeSession({ headline: "Planned the export", summary: "### Done\n- plan" });
    t.atlas.hookEnd({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr.path });

    const text = onlySession(t);
    expect(text).toContain("decision: CSV first, because finance asked for it");
    expect(text).toContain("asked: Plan the export");
    expect(text).toContain("asked: Now write it");
    expect(text).toContain("Planned the export");
    expect(text).toContain("status: closed");
  });

  it("keeps writing to the same note when a conversation is reopened or resumed", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const tr = transcriptFile(t);
    const cwd = t.cwd("alpha");
    t.atlas.hookStart({ sessionId: "cc-1", cwd, transcriptPath: tr.path });
    tr.add(user("2026-10-08T08:01:00Z", "first day"));
    t.atlas.hookEnd({ sessionId: "cc-1", cwd, transcriptPath: tr.path });

    t.at("2026-10-09T10:00:00+02:00");
    t.atlas.hookStart({ sessionId: "cc-1", cwd, transcriptPath: tr.path });
    const mcp = t.atlas.session({ clientSessionId: "cc-1" });
    tr.add(user("2026-10-09T08:01:00Z", "second day"));
    t.atlas.capture({ sessionId: "cc-1", cwd });
    expect(onlySession(t)).toContain("status: open");
    mcp.log({ type: "note", text: "resumed" });
    t.atlas.hookEnd({ sessionId: "cc-1", cwd, transcriptPath: tr.path });

    const text = onlySession(t);
    expect(text.match(/asked: first day/g)).toHaveLength(1);
    expect(text).toContain("asked: second day");
    expect(text).toContain("note: resumed");
    expect(text).toContain("status: closed");
  });

  it("lets a day built only from activity roll up, with the activity as its source", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const tr = transcriptFile(t);
    tr.add(user("2026-10-08T08:01:00Z", "Fix the rounding bug in EUR invoices"), reply("2026-10-08T09:00:00Z", "Fixed: switched to half-up."));
    t.atlas.hookStart({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr.path });
    t.atlas.hookEnd({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr.path });

    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    expect(s.pending().items.map((i) => [i.period, i.blocked])).toEqual([["2026-10-08", false]]);
    const job = s.summarize({ period: "2026-10-08" });
    expect(job.sources).toContain("Fix the rounding bug in EUR invoices");
    expect(job.sources).toContain("Fixed: switched to half-up.");
    expect(s.brief()).toContain("Fix the rounding bug in EUR invoices");
  });

  it("scrubs secrets from captured requests", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const tr = transcriptFile(t);
    tr.add(user("2026-10-08T08:01:00Z", "use the key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx please"));
    t.atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr.path });
    expect(onlySession(t)).toContain("[redacted:anthropic]");
  });

  it("marks a sealed day stale when more activity lands on it", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const tr = transcriptFile(t);
    tr.add(user("2026-10-08T08:01:00Z", "first ask"));
    t.atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: tr.path });
    t.at("2026-10-09T09:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("alpha") }).seal({ period: "2026-10-08", headline: "Day", content: "Work." });
    tr.add(user("2026-10-08T09:00:00Z", "late addition"));
    expect(t.atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha") })).toMatchObject({ nowStale: ["2026-10-08"] });
  });
});

describe("hook entry point", () => {
  it("runs the stop event and skips the atlas's own child runs", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const tr = transcriptFile(t);
    tr.add(user("2026-10-08T08:01:00Z", "hello"));
    const payload = { session_id: "cc-1", cwd: t.cwd("alpha"), transcript_path: tr.path };
    expect(runHook(t.atlas, "stop", payload, { TEMPORAL_ATLAS_CHILD: "1" })).toMatchObject({ result: "skipped" });
    expect(t.files("scopes")).toEqual([]);
    expect(runHook(t.atlas, "stop", payload, {})).toMatchObject({ result: "captured" });
  });
});

describe("reading transcripts", () => {
  it("keeps what a person typed and drops injected context", () => {
    expect(askText({ message: { content: "<system-reminder>be brief</system-reminder>\nShip it" } })).toBe("Ship it");
    expect(askText({ message: { content: "<task-notification>done</task-notification>" } })).toBeUndefined();
    expect(askText({ message: { content: "<command-name>/review</command-name><command-args>PR 12</command-args>" } })).toBe("/review PR 12");
    expect(askText({ isMeta: true, message: { content: "meta" } })).toBeUndefined();
    expect(askText({ message: { content: [{ type: "text", text: "with blocks" }] } })).toBe("with blocks");
  });

  it("recognises commits, pushes and PRs", () => {
    expect(milestone(`git commit -m "$(cat <<'EOF'\nAdd capture\n\nBody\nEOF\n)"`)).toBe("commit: Add capture");
    expect(milestone("git add . && git commit -m 'Fix bug'")).toBe("commit: Fix bug");
    expect(milestone('gh pr create --title "Capture hooks" --body x')).toBe("opened PR: Capture hooks");
    expect(milestone("git push -u origin main")).toBe("pushed (-u origin main)");
    expect(milestone("ls -la")).toBeUndefined();
    expect(milestone("npm publish --access public")).toBe("published to npm");
    expect(milestone("npm publish --dry-run")).toBeUndefined();
  });

  it("reads a transcript that is still being written up to its last full line", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const path = join(t.root, "partial.jsonl");
    writeFileSync(path, `${JSON.stringify(user("2026-10-08T08:01:00Z", "complete"))}\n{"type":"user","timest`);
    t.atlas.capture({ sessionId: "cc-1", cwd: t.cwd("alpha"), transcriptPath: path });
    const state = JSON.parse(readFileSync(t.atlas.paths.captureFile("cc-1"), "utf8"));
    expect(state.offset).toBe(readFileSync(path, "utf8").indexOf("\n") + 1);
  });
});

describe("backfill", () => {
  function legacy(t: T, scope: string, id: string, transcriptPath: string) {
    const dir = join(t.dir, `scopes/${scope}/sessions/2026/10`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `2026-10-08T1000-${id}.md`),
      `---\natlas: session\nscope: ${scope}\nsession: ${id}\nstarted: 2026-10-08T10:00:00+02:00\nstatus: closed\ntranscript: ${transcriptPath}\ndays:\n  - 2026-10-08\n---\n# Session 2026-10-08 10:00\n\nRecorded by a hook only. Summarize it from its transcript.\n`,
    );
  }

  it("records older hook-only sessions from transcripts and skips headless ones", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const real = transcriptFile(t, "real.jsonl");
    real.add({ ...user("2026-10-08T08:01:00Z", "Add the CSV export"), cwd: t.cwd("alpha") });
    const child = transcriptFile(t, "child.jsonl");
    child.add(user("2026-10-08T08:05:00Z", "<transcript>x</transcript> summarize", "sdk"));
    legacy(t, "alpha", "aaa111", real.path);
    legacy(t, "alpha", "bbb222", child.path);

    const dry = backfill(t.atlas, { dryRun: true });
    expect(dry).toMatchObject({ captured: ["2026-10-08T1000-aaa111"], headless: ["2026-10-08T1000-bbb222"] });
    expect(t.read("scopes/alpha/sessions/2026/10/2026-10-08T1000-aaa111.md")).not.toContain("### Activity");

    backfill(t.atlas);
    expect(t.read("scopes/alpha/sessions/2026/10/2026-10-08T1000-aaa111.md")).toContain("asked: Add the CSV export");
    expect(t.read("scopes/alpha/sessions/2026/10/2026-10-08T1000-bbb222.md")).toContain("capture: skipped");
    t.at("2026-10-09T09:00:00+02:00");
    expect(t.atlas.session({ cwd: t.cwd("alpha") }).pending().items.map((i) => i.period)).toEqual(["2026-10-08"]);
  });

  it("folds the notes of a reopened conversation into one", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const tr = transcriptFile(t);
    tr.add(user("2026-10-08T08:01:00Z", "day one"), user("2026-10-09T08:01:00Z", "day two"));
    legacy(t, "alpha", "aaa111", tr.path);
    const dir = join(t.dir, "scopes/alpha/sessions/2026/10");
    writeFileSync(
      join(dir, "2026-10-09T1000-bbb222.md"),
      `---\natlas: session\nscope: alpha\nsession: bbb222\nstarted: 2026-10-09T10:00:00+02:00\nstatus: closed\ntranscript: ${tr.path}\ndays:\n  - 2026-10-09\n---\n# Session\n`,
    );
    const r = backfill(t.atlas);
    expect(r.captured).toEqual(["2026-10-08T1000-aaa111"]);
    expect(r.duplicates).toEqual(["2026-10-09T1000-bbb222"]);
    const main = t.read("scopes/alpha/sessions/2026/10/2026-10-08T1000-aaa111.md");
    expect(main).toContain("asked: day one");
    expect(main).toContain("asked: day two");
    expect(t.read("scopes/alpha/sessions/2026/10/2026-10-09T1000-bbb222.md")).toContain("capture: skipped");
  });

  it("deletes headless runs with prune", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const child = transcriptFile(t, "child.jsonl");
    child.add(user("2026-10-08T08:05:00Z", "<transcript>x</transcript> summarize", "sdk"));
    legacy(t, "alpha", "bbb222", child.path);
    backfill(t.atlas, { prune: true });
    expect(existsSync(join(t.dir, "scopes/alpha/sessions/2026/10/2026-10-08T1000-bbb222.md"))).toBe(false);
  });

  it("merges a scope whose sessions all ran in a general folder into general", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const Atlas = t.atlas.constructor as typeof import("../src/atlas.js").Atlas;
    const atlas = new Atlas({ dir: t.dir, clock: () => new Date("2026-10-08T10:00:00+02:00"), config: { timezone: "Europe/Madrid", capture: { headless: false, ignorePaths: [], generalPaths: [t.cwd("client-x")] } } });
    const tr = transcriptFile(t);
    tr.add({ ...user("2026-10-08T08:01:00Z", "scratch question"), cwd: t.cwd("client-x") });
    legacy(t, "scratch-2026-10-08-abc123", "ccc333", tr.path);
    expect(backfill(atlas).merged).toEqual(["scratch-2026-10-08-abc123"]);
    expect(t.files("scopes").some((f) => f.startsWith("scopes/general/sessions/"))).toBe(true);
    expect(t.files("scopes").some((f) => f.startsWith("scopes/scratch-"))).toBe(false);
  });
});
