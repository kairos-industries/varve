import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

function workDay(t: ReturnType<typeof setup>, day: string, headline: string, scope = "alpha") {
  t.at(`${day}T10:00:00+02:00`);
  const s = t.atlas.session({ cwd: t.cwd(scope) });
  s.log({ type: "change", text: `${headline} work` });
  s.closeSession({ headline, summary: `### Done\n- ${headline}` });
  return s;
}

const short = "### What happened\n- Work happened.";

describe("pending rollups", () => {
  it("has nothing pending while the day is open", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = workDay(t, "2026-10-08", "Built the parser");
    expect(s.pending().items).toEqual([]);
  });

  it("lists a day once it closes, with an estimate under the gate", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    workDay(t, "2026-10-08", "Built the parser");
    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    const { items } = s.pending();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ period: "2026-10-08", layer: "day", scope: "alpha", gate: "auto", blocked: false });
    expect(items[0]!.tokens).toBeGreaterThan(0);
  });

  it("orders by end date, so days come before the week and month they roll into", () => {
    const t = setup("2026-10-30T10:00:00+02:00");
    workDay(t, "2026-10-30", "Friday work");
    t.at("2026-11-02T09:00:00+01:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    expect(s.pending().items.map((i) => i.period)).toEqual(["2026-10-30", "2026-10", "2026-W44"]);
  });
});

describe("summarize and seal", () => {
  it("hands over the session material and seals the day note", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    workDay(t, "2026-10-08", "Built the parser");
    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });

    const job = s.summarize({ period: "2026-10-08" });
    expect(job.lengthTarget).toBe(600);
    expect(job.sources).toContain("Built the parser");
    expect(job.sources).toContain("Built the parser work");

    const result = s.seal({ period: "2026-10-08", headline: "Parser built", content: short });
    expect(result.path).toMatch(/scopes[\\/]alpha[\\/]days[\\/]2026[\\/]2026-10-08 alpha\.md$/);
    const note = t.read("scopes/alpha/days/2026/2026-10-08 alpha.md");
    expect(note).toContain("status: sealed");
    expect(note).toContain("headline: Parser built");
    expect(s.pending().items).toEqual([]);
  });

  it("builds weeks and months from sealed day notes", () => {
    const t = setup("2026-10-30T10:00:00+02:00");
    workDay(t, "2026-10-30", "Friday work");
    t.at("2026-11-02T09:00:00+01:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.seal({ period: "2026-10-30", headline: "Friday sealed", content: "Friday details" });

    for (const period of ["2026-W44", "2026-10"]) {
      const job = s.summarize({ period });
      expect(job.sources).toContain("Friday details");
      expect(job.sources).toContain("[[2026-10-30 alpha");
    }
  });

  it("refuses a week whose days are not sealed yet", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    workDay(t, "2026-10-08", "Thursday work");
    t.at("2026-10-12T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    expect(s.pending().items.find((i) => i.period === "2026-W41")?.blocked).toBe(true);
    expect(() => s.summarize({ period: "2026-W41" })).toThrow(/2026-10-08/);
  });

  it("refuses a period that is still open or already sealed", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = workDay(t, "2026-10-08", "Thursday work");
    expect(() => s.summarize({ period: "2026-10-08" })).toThrow(/not pending/);
  });

  it("rejects content far over the length target", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    workDay(t, "2026-10-08", "Thursday work");
    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    expect(() => s.seal({ period: "2026-10-08", headline: "x", content: "word ".repeat(800) })).toThrow(/600/);
  });

  it("lets only one agent summarize a period at a time", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    workDay(t, "2026-10-08", "Thursday work");
    t.at("2026-10-09T09:00:00+02:00");
    const a = t.atlas.session({ cwd: t.cwd("alpha") });
    const b = t.atlas.session({ cwd: t.cwd("alpha") });
    a.summarize({ period: "2026-10-08" });
    expect(() => b.summarize({ period: "2026-10-08" })).toThrow(/in progress/);
    expect(() => b.seal({ period: "2026-10-08", headline: "x", content: short })).toThrow(/in progress/);
    a.seal({ period: "2026-10-08", headline: "x", content: short });
  });
});

describe("cost gate", () => {
  it("asks for confirmation once the running total passes the gate", () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    const big = "detail ".repeat(3000); // about 5k tokens per day
    for (const day of ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]) {
      t.at(`${day}T10:00:00+02:00`);
      const s = t.atlas.session({ cwd: t.cwd("alpha") });
      s.closeSession({ headline: `Work on ${day}`, summary: big });
    }
    t.at("2026-10-12T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    const { items, totalTokens } = s.pending();
    const gates = items.map((i) => i.gate);
    expect(gates.slice(0, 5)).toEqual(["auto", "auto", "auto", "auto", "auto"]);
    expect(gates.at(-1)).toBe("needs_confirmation");
    expect(totalTokens).toBeGreaterThan(30000);

    const late = items.find((i) => i.gate === "needs_confirmation" && !i.blocked)!;
    expect(() => s.summarize({ period: late.period })).toThrow(/confirm/i);
    expect(s.summarize({ period: late.period, confirmed: true }).sources).toContain("detail");
  });
});

describe("drafts and index notes", () => {
  it("writes a day draft listing closed sessions", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    workDay(t, "2026-10-08", "Built the parser");
    const draft = t.read("scopes/alpha/days/2026/2026-10-08 alpha.md");
    expect(draft).toContain("status: draft");
    expect(draft).toContain("Built the parser");
  });

  it("puts the sealed day headline in the week draft and the index", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    workDay(t, "2026-10-08", "Built the parser");
    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.seal({ period: "2026-10-08", headline: "Parser built", content: short });
    expect(t.read("scopes/alpha/weeks/2026/2026-W41 alpha.md")).toContain("Parser built");
    expect(t.read("index/days/2026/2026-10-08.md")).toContain("Parser built");
  });

  it("keeps isolated scopes out of index notes", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("client-x") }).scopes({ set: { scope: "client-x", isolated: true } });
    workDay(t, "2026-10-08", "Client secret plan", "client-x");
    workDay(t, "2026-10-08", "Open source work", "alpha");
    const index = t.read("index/days/2026/2026-10-08.md");
    expect(index).toContain("Open source work");
    expect(index).not.toContain("Client secret plan");
  });
});
