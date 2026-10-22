import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Atlas } from "../src/atlas.js";
import { doctor } from "../src/cli/doctor.js";
import { mergeHooks } from "../src/cli/install.js";
import { cronLine, launchdPlist, setRollupMode, tidyProgram } from "../src/cli/nightly.js";
import { claudeArgs, claudeRunner, type ModelRunner, parseReply, tidy, tidyPlan } from "../src/tidy/index.js";
import { setup } from "./helpers.js";

function workDays(t: ReturnType<typeof setup>, days: string[]) {
  for (const day of days) {
    t.at(`${day}T10:00:00+02:00`);
    t.atlas.session({ cwd: t.cwd("alpha") }).closeSession({ headline: `Work on ${day}`, summary: `### Done\n- ${day}` });
  }
}

/** A model that answers every rollup with a short note, and records what it was asked. */
function fakeModel(costPerCall = 0.01) {
  const prompts: string[] = [];
  const runner: ModelRunner = async (prompt) => {
    prompts.push(prompt);
    const period = /# Sources for (\S+)/.exec(prompt)?.[1];
    return { text: `Headline: Summary of ${period}\n\n### What happened\n- Work.`, costUsd: costPerCall, inputTokens: 1000, outputTokens: 50 };
  };
  return { runner, prompts };
}

describe("tidy", () => {
  it("writes days first, then the week and month they unblock", async () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    workDays(t, ["2026-10-05", "2026-10-06"]);
    t.at("2026-11-02T09:00:00+01:00");
    const model = fakeModel();
    const report = await tidy(t.atlas, { runner: model.runner, model: "sonnet", maxTokens: 1e6, maxUsd: 5 });

    expect(report.outcomes.map((o) => [o.period, o.result])).toEqual([
      ["2026-10-05", "sealed"],
      ["2026-10-06", "sealed"],
      ["2026-W41", "sealed"],
      ["2026-10", "sealed"],
    ]);
    expect(report.left).toBe(0);
    expect(report.spentUsd).toBeCloseTo(0.04);
    expect(model.prompts[0]).toContain("Headline: <one line");
    expect(model.prompts[0]).not.toContain("call seal");
    expect(t.read("scopes/alpha/weeks/2026/2026-W41 alpha.md")).toContain("headline: Summary of 2026-W41");
    const log = readFileSync(t.atlas.paths.tidyLog, "utf8").trim().split("\n");
    expect(log).toHaveLength(4);
    expect(JSON.parse(log[0]!)).toMatchObject({ period: "2026-10-05", result: "sealed", costUsd: 0.01 });
  });

  it("stops before the token budget runs out", async () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    workDays(t, ["2026-10-05", "2026-10-06"]);
    t.at("2026-10-08T09:00:00+02:00");
    const report = await tidy(t.atlas, { runner: fakeModel().runner, model: "sonnet", maxTokens: 1500, maxUsd: 5 });
    expect(report.outcomes).toHaveLength(1);
    expect(report.stoppedBecause).toMatch(/token budget/);
  });

  it("stops once the dollar budget is spent", async () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    workDays(t, ["2026-10-05", "2026-10-06"]);
    t.at("2026-10-08T09:00:00+02:00");
    const report = await tidy(t.atlas, { runner: fakeModel(0.5).runner, model: "sonnet", maxTokens: 1e6, maxUsd: 0.5 });
    expect(report.outcomes).toHaveLength(1);
    expect(report.stoppedBecause).toMatch(/\$0\.50/);
  });

  it("asks again once when a note is too long, then gives up on that rollup", async () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    workDays(t, ["2026-10-05"]);
    t.at("2026-10-07T09:00:00+02:00");
    let calls = 0;
    const runner: ModelRunner = async () => {
      calls++;
      return { text: `Headline: Long\n\n${"word ".repeat(2000)}` };
    };
    const report = await tidy(t.atlas, { runner, model: "sonnet", maxTokens: 1e6, maxUsd: 5 });
    expect(calls).toBe(2);
    expect(report.outcomes[0]).toMatchObject({ result: "failed" });
    expect(tidyPlan(t.atlas)).toHaveLength(1);
  });

  it("leaves orphan sessions alone unless asked", () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    writeFileSync(join(t.root, "x.jsonl"), "");
    const path = join(t.dir, "scopes/alpha/sessions/2026/10/2026-10-05T1000-orph01.md");
    const atlas = t.atlas;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `---\natlas: session\nscope: alpha\nsession: orph01\nstarted: 2026-10-05T10:00:00+02:00\nstatus: closed\ntranscript: ${join(t.root, "x.jsonl")}\ndays:\n  - 2026-10-05\n---\n# Session\n`,
    );
    t.at("2026-10-07T09:00:00+02:00");
    expect(tidyPlan(atlas)).toEqual([]);
    expect(tidyPlan(atlas, { orphans: true }).map((i) => i.layer)).toEqual(["session"]);
  });
});

describe("parsing model replies", () => {
  it("reads the headline line and the note", () => {
    expect(parseReply("Headline: Did things\n\n### What happened\n- x")).toEqual({ headline: "Did things", content: "### What happened\n- x" });
    expect(parseReply("```markdown\n**Headline:** Bold one\n\nBody\n```")).toEqual({ headline: "Bold one", content: "Body" });
    expect(() => parseReply("Just a note")).toThrow(/Headline/);
  });
});

describe("the claude runner", () => {
  it("passes no tools, no MCP servers, no user hooks and no transcript, and reads the JSON result", async () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    const fake = join(t.root, "fake-claude");
    const argsFile = join(t.root, "args.json");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), child: process.env.TEMPORAL_ATLAS_CHILD, input }));
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Headline: H\\n\\nBody", total_cost_usd: 0.0123, usage: { input_tokens: 900, output_tokens: 40 } }));
});
`,
    );
    chmodSync(fake, 0o755);
    const atlas = new Atlas({ dir: t.dir, config: { tidy: { command: fake, model: "haiku", maxTokens: 1000, maxUsd: 1, at: "04:30" } } });
    const reply = await claudeRunner(atlas)("the prompt", { model: "haiku", maxUsd: 0.75 });
    expect(reply).toEqual({ text: "Headline: H\n\nBody", costUsd: 0.0123, inputTokens: 900, outputTokens: 40 });
    const seen = JSON.parse(readFileSync(argsFile, "utf8"));
    expect(seen.child).toBe("1");
    expect(seen.input).toBe("the prompt");
    expect(seen.args).toEqual(claudeArgs("haiku", 0.75));
    for (const f of ["--no-session-persistence", "--strict-mcp-config", "--tools"]) expect(seen.args).toContain(f);
    expect(seen.args[seen.args.indexOf("--max-budget-usd") + 1]).toBe("0.75");
  });

  it("reports a budget stop from claude", async () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    const fake = join(t.root, "fake-claude");
    writeFileSync(fake, `#!/bin/sh\ncat > /dev/null\necho '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":0.5}'\n`);
    chmodSync(fake, 0o755);
    const atlas = new Atlas({ dir: t.dir, config: { tidy: { command: fake, model: "haiku", maxTokens: 1000, maxUsd: 1, at: "04:30" } } });
    await expect(claudeRunner(atlas)("p", { model: "haiku", maxUsd: 0.5 })).rejects.toMatchObject({ budget: true, costUsd: 0.5 });
  });
});

describe("nightly mode", () => {
  it("tells agents to leave rollups to the nightly run", () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    workDays(t, ["2026-10-05"]);
    t.at("2026-10-07T09:00:00+02:00");
    setRollupMode(t.dir, "nightly");
    const atlas = new Atlas({ dir: t.dir, clock: () => new Date("2026-10-07T09:00:00+02:00"), config: { timezone: "Europe/Madrid" } });
    const s = atlas.session({ cwd: t.cwd("alpha") });
    expect(s.instructions()).toContain("Rollups run overnight");
    expect(s.brief()).toContain("The nightly run writes them");
    expect(JSON.parse(readFileSync(join(t.dir, "atlas.config.json"), "utf8")).rollups).toBe("nightly");
  });

  it("builds a launchd job and a cron line that run tidy --yes", () => {
    const program = tidyProgram("/repo/dist/cli/main.js", "/usr/local/bin/node");
    expect(program).toEqual(["/usr/local/bin/node", "/repo/dist/cli/main.js", "tidy", "--yes"]);
    const plist = launchdPlist({ program, atlasDir: "/Users/me/Atlas & Co", at: "04:30", path: "/usr/bin", log: "/tmp/tidy.out" });
    expect(plist).toContain("<integer>4</integer>");
    expect(plist).toContain("<integer>30</integer>");
    expect(plist).toContain("/Users/me/Atlas &amp; Co");
    expect(cronLine({ program, atlasDir: "/a", at: "04:30", log: "/a/.atlas/tidy.out" })).toBe(
      "30 4 * * * TEMPORAL_ATLAS_DIR='/a' '/usr/local/bin/node' '/repo/dist/cli/main.js' 'tidy' '--yes' >> '/a/.atlas/tidy.out' 2>&1",
    );
  });
});

describe("doctor warnings", () => {
  it("does not warn in nightly mode before the first run, only when the backlog exceeds a night or the runs stop", () => {
    const t = setup("2026-10-01T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("alpha") }).closeSession({ headline: "x", summary: "y".repeat(400) });
    setRollupMode(t.dir, "nightly");
    const at = (iso: string, tidy = { command: "claude", model: "sonnet", maxTokens: 200000, maxUsd: 2, at: "04:30" }) =>
      new Atlas({ dir: t.dir, clock: () => new Date(iso), config: { timezone: "Europe/Madrid", costGateTokens: 10, tidy } });
    const settings = join(t.root, "none.json");
    expect(doctor(at("2026-10-08T10:00:00+02:00"), { settingsPath: settings }).warnings).toEqual([]);
    const small = { command: "claude", model: "sonnet", maxTokens: 50, maxUsd: 2, at: "04:30" };
    expect(doctor(at("2026-10-08T10:00:00+02:00", small), { settingsPath: settings }).warnings.join("\n")).toMatch(/several nights/);
    mkdirSync(join(t.dir, ".atlas"), { recursive: true });
    writeFileSync(join(t.dir, ".atlas/tidy.log"), `${JSON.stringify({ at: "2026-10-02T04:30:00+02:00", result: "sealed" })}\n`);
    expect(doctor(at("2026-10-08T10:00:00+02:00"), { settingsPath: settings }).warnings.join("\n")).toMatch(/has not written one since 2026-10-02/);
  });

  it("warns about a backlog over the gate and hooks from an older version", () => {
    const t = setup("2026-10-01T10:00:00+02:00");
    const atlas = new Atlas({ dir: t.dir, clock: () => new Date("2026-10-01T10:00:00+02:00"), config: { timezone: "Europe/Madrid", costGateTokens: 10 } });
    atlas.session({ cwd: t.cwd("alpha") }).closeSession({ headline: "x", summary: "y".repeat(200) });
    const later = new Atlas({ dir: t.dir, clock: () => new Date("2026-10-08T10:00:00+02:00"), config: { timezone: "Europe/Madrid", costGateTokens: 10 } });
    const settings = join(t.root, "settings.json");
    const old = mergeHooks({}, "node /x/dist/cli/main.js hook") as { hooks: Record<string, unknown[]> };
    delete old.hooks.Stop;
    writeFileSync(settings, JSON.stringify(old));
    const r = doctor(later, { settingsPath: settings });
    expect(r.hooks).toEqual(["SessionStart", "SessionEnd"]);
    expect(r.warnings.join("\n")).toMatch(/over the 10-token cost gate/);
    expect(r.warnings.join("\n")).toMatch(/older version/);
  });
});
