import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("recording a session", () => {
  it("writes nothing until the first log", () => {
    const t = setup("2026-10-08T14:32:00+02:00");
    t.atlas.session({ cwd: t.cwd("alpha") });
    expect(t.files("scopes")).toEqual([]);
  });

  it("creates the session note in the detected scope on first log", () => {
    const t = setup("2026-10-08T14:32:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    t.at("2026-10-08T14:35:00+02:00");
    s.log({ type: "decision", text: "Use 04:00 as the day boundary", topics: ["Time model"] });

    const [file] = t.files("scopes");
    expect(file).toMatch(/^scopes\/alpha\/sessions\/2026\/10\/2026-10-08T1432-[a-z0-9]{6}\.md$/);
    const text = t.read(file!);
    expect(text).toContain("## 2026-10-08");
    expect(text).toContain("- 14:35 decision: Use 04:00 as the day boundary [[Time model]]");
  });

  it("splits a session that runs past 04:00 into day segments", () => {
    const t = setup("2026-10-07T22:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.log({ type: "change", text: "Evening work" });
    t.at("2026-10-08T01:30:00+02:00");
    s.log({ type: "change", text: "Still the 7th" });
    t.at("2026-10-08T09:10:00+02:00");
    s.log({ type: "change", text: "Next morning" });

    const text = t.read(t.files("scopes")[0]!);
    const seventh = text.indexOf("## 2026-10-07");
    const eighth = text.indexOf("## 2026-10-08");
    expect(seventh).toBeGreaterThan(-1);
    expect(eighth).toBeGreaterThan(seventh);
    expect(text.indexOf("Still the 7th")).toBeLessThan(eighth);
    expect(text.indexOf("Next morning")).toBeGreaterThan(eighth);
  });

  it("closes the session with a headline and summary", () => {
    const t = setup("2026-10-08T14:32:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.log({ type: "note", text: "start" });
    s.closeSession({ headline: "Built the time model", summary: "### Done\n- time module\n\n### Open threads\n- DST tests" });

    const text = t.read(t.files("scopes")[0]!);
    expect(text).toContain("status: closed");
    expect(text).toContain("Built the time model");
    expect(text).toContain("- DST tests");
  });

  it("summarizes a finished day segment without closing the session", () => {
    const t = setup("2026-10-07T22:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.log({ type: "change", text: "Evening work" });
    t.at("2026-10-08T09:00:00+02:00");
    s.closeSession({ headline: "Evening on the parser", summary: "Parser done.", segment: "2026-10-07" });

    const text = t.read(t.files("scopes")[0]!);
    expect(text).toContain("status: open");
    expect(text).toContain("Evening on the parser");
  });

  it("reopens a closed session when the agent keeps logging", () => {
    const t = setup("2026-10-08T14:32:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.closeSession({ headline: "Done", summary: "x" });
    s.log({ type: "note", text: "one more thing" });
    expect(t.read(t.files("scopes")[0]!)).toContain("status: open");
  });

  it("scrubs secrets from logged text", () => {
    const t = setup("2026-10-08T14:32:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.log({ type: "finding", text: "the key was sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx" });
    expect(t.read(t.files("scopes")[0]!)).toContain("[redacted:anthropic]");
  });

  it("lets the agent name the scope on the first log when there is no working directory", () => {
    const t = setup("2026-10-08T14:32:00+02:00");
    const s = t.atlas.session({});
    expect(s.scope).toBe("general");
    s.log({ type: "note", text: "planning", scope: "Beta Launch" });
    expect(t.files("scopes")[0]).toMatch(/^scopes\/beta-launch\//);
  });
});
