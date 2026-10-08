import { describe, expect, it } from "vitest";
import { tokens } from "../src/config.js";
import { setup } from "./helpers.js";

function work(t: ReturnType<typeof setup>, at: string, scope: string, headline: string, summary = `### Done\n- ${headline}`) {
  t.at(at);
  const s = t.atlas.session({ cwd: t.cwd(scope) });
  s.log({ type: "change", text: `${headline} event` });
  s.closeSession({ headline, summary });
  return s;
}

describe("brief", () => {
  it("shows the last session in full, today, and the last worked day", () => {
    const t = setup("2026-10-07T10:00:00+02:00");
    work(t, "2026-10-07T10:00:00+02:00", "alpha", "Wednesday parser work");
    work(t, "2026-10-08T10:00:00+02:00", "alpha", "Thursday lexer work", "### Done\n- lexer\n\n### Open threads\n- unicode identifiers");
    t.at("2026-10-08T15:00:00+02:00");
    const brief = t.atlas.session({ cwd: t.cwd("alpha") }).brief();

    expect(brief).toContain("# Atlas brief: alpha");
    expect(brief).toMatch(/## Last session[\s\S]*Thursday lexer work[\s\S]*unicode identifiers/);
    expect(brief).toMatch(/## Today[\s\S]*Thursday lexer work/);
    expect(brief).toMatch(/## Last worked day: Wed 2026-10-07[\s\S]*Wednesday parser work/);
  });

  it("treats Friday as the last worked day on Monday", () => {
    const t = setup("2026-10-09T10:00:00+02:00");
    work(t, "2026-10-09T10:00:00+02:00", "alpha", "Friday release");
    t.at("2026-10-12T09:00:00+02:00");
    expect(t.atlas.session({ cwd: t.cwd("alpha") }).brief()).toMatch(/## Last worked day: Fri 2026-10-09[\s\S]*Friday release/);
  });

  it("uses the sealed note for a sealed day", () => {
    const t = setup("2026-10-07T10:00:00+02:00");
    work(t, "2026-10-07T10:00:00+02:00", "alpha", "Wednesday parser work");
    t.at("2026-10-08T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.seal({ period: "2026-10-07", headline: "Parser finished", content: "### What happened\n- Finished the parser, 3 passes." });
    expect(s.brief()).toMatch(/## Last worked day: Wed 2026-10-07[\s\S]*Parser finished[\s\S]*3 passes/);
  });

  it("lists pending rollups", () => {
    const t = setup("2026-10-07T10:00:00+02:00");
    work(t, "2026-10-07T10:00:00+02:00", "alpha", "Wednesday parser work");
    t.at("2026-10-08T09:00:00+02:00");
    expect(t.atlas.session({ cwd: t.cwd("alpha") }).brief()).toMatch(/## Pending rollups\n1 rollup pending/);
  });

  it("shows other open scopes' headlines but never an isolated scope's", () => {
    const t = setup("2026-10-07T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("client-x") }).scopes({ set: { scope: "client-x", isolated: true } });
    work(t, "2026-10-07T10:00:00+02:00", "beta", "Beta landing page");
    work(t, "2026-10-07T11:00:00+02:00", "client-x", "Client pricing model");
    work(t, "2026-10-07T12:00:00+02:00", "alpha", "Alpha work");
    const brief = t.atlas.session({ cwd: t.cwd("alpha") }).brief();
    expect(brief).toMatch(/## Elsewhere this week[\s\S]*beta[\s\S]*Beta landing page/);
    expect(brief).not.toContain("Client pricing model");

    const fromClient = t.atlas.session({ cwd: t.cwd("client-x") }).brief();
    expect(fromClient).toContain("(isolated)");
    expect(fromClient).not.toContain("Beta landing page");
  });

  it("refuses to brief an isolated scope from outside", () => {
    const t = setup("2026-10-07T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("client-x") }).scopes({ set: { scope: "client-x", isolated: true } });
    expect(() => t.atlas.session({ cwd: t.cwd("alpha") }).brief({ scope: "client-x" })).toThrow(/isolated/);
  });

  it("shows the year only once a month has been sealed", () => {
    const t = setup("2026-09-30T10:00:00+02:00");
    work(t, "2026-09-30T10:00:00+02:00", "alpha", "September close");
    t.at("2026-10-02T10:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    expect(s.brief()).not.toContain("## This year");
    s.seal({ period: "2026-09-30", headline: "Sept 30", content: "x" });
    s.seal({ period: "2026-09", headline: "September: shipped v1", content: "Shipped v1." });
    expect(s.brief()).toMatch(/## This year: 2026[\s\S]*September: shipped v1/);
  });

  it("stays within the token caps", () => {
    const t = setup("2026-10-01T10:00:00+02:00");
    const long = "### Done\n" + "- a long line of detail about the work done today\n".repeat(400);
    for (let d = 1; d <= 8; d++) work(t, `2026-10-0${d}T10:00:00+02:00`, "alpha", `Day ${d} work`, long);
    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    expect(tokens(s.brief())).toBeLessThanOrEqual(5000);
    expect(tokens(s.instructions())).toBeLessThanOrEqual(1500);
    expect(s.instructions()).toContain("Day 8 work");
  });
});

describe("zoom", () => {
  it("opens a week and lists its days", () => {
    const t = setup("2026-10-06T10:00:00+02:00");
    work(t, "2026-10-06T10:00:00+02:00", "alpha", "Tuesday work");
    work(t, "2026-10-08T10:00:00+02:00", "alpha", "Thursday work");
    const z = t.atlas.session({ cwd: t.cwd("alpha") }).zoom({ period: "2026-W41" });
    expect(z.status).toBe("draft");
    expect(z.children.map((c) => c.id)).toEqual(["2026-10-06", "2026-10-08"]);
    expect(z.children[1]!.headline).toContain("Thursday work");
  });

  it("opens a day and lists its sessions, then a session", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = work(t, "2026-10-08T10:00:00+02:00", "alpha", "Thursday work");
    const day = s.zoom({ period: "2026-10-08" });
    expect(day.children).toHaveLength(1);
    const session = s.zoom({ period: day.children[0]!.id });
    expect(session.layer).toBe("session");
    expect(session.content).toContain("Thursday work event");
  });
});

describe("search", () => {
  it("finds notes by keyword with scope and layer filters", () => {
    const t = setup("2026-10-06T10:00:00+02:00");
    work(t, "2026-10-06T10:00:00+02:00", "alpha", "Chose Postgres for the ledger");
    work(t, "2026-10-07T10:00:00+02:00", "beta", "Postgres tuning for beta");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    const all = s.search({ query: "postgres" });
    expect(new Set(all.map((r) => r.scope))).toEqual(new Set(["alpha", "beta"]));
    expect(s.search({ query: "postgres", scope: "beta" }).every((r) => r.scope === "beta")).toBe(true);
    expect(s.search({ query: "postgres", layer: "session" }).every((r) => r.layer === "session")).toBe(true);
    expect(s.search({ query: "ledger", layer: "session", from: "2026-10-07" })).toEqual([]);
    expect(s.search({ query: "ledger", layer: "session", to: "2026-10-06" })).toHaveLength(1);
  });

  it("never returns isolated scopes from outside", () => {
    const t = setup("2026-10-06T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("client-x") }).scopes({ set: { scope: "client-x", isolated: true } });
    work(t, "2026-10-06T10:00:00+02:00", "client-x", "Secret merger plan");
    expect(t.atlas.session({ cwd: t.cwd("alpha") }).search({ query: "merger" })).toEqual([]);
    expect(t.atlas.session({ cwd: t.cwd("client-x") }).search({ query: "merger" }).length).toBeGreaterThan(0);
  });
});
