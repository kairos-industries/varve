import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClaim, parseHistory, parseOpen, renderClaim } from "../src/claims.js";
import { tidy, type ModelRunner } from "../src/tidy/index.js";
import { topicState } from "../src/topics.js";
import { setup } from "./helpers.js";

type T = ReturnType<typeof setup>;

function workDay(t: T, day: string, events: [string, string][] = []) {
  t.at(`${day}T10:00:00+02:00`);
  const s = t.atlas.session({ cwd: t.cwd("alpha") });
  for (const [type, text] of events) s.log({ type, text });
  s.closeSession({ headline: `Work on ${day}`, summary: `### Done\n- ${day}` });
  return s;
}

const topicFile = (t: T, name: string) => readFileSync(`${t.dir}/scopes/alpha/topics/${name}.md`, "utf8");

describe("claims in topic notes", () => {
  it("writes a dated claim with its source and an id, and reads it back", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = workDay(t, "2026-10-08", [["decision", "Okta for enterprise sign-in"]]);
    const r = s.topic({ name: "Auth design", force: true, update: { claims: [{ text: "Enterprise users sign in through Okta (SAML)." }] } });
    expect(r.changes).toEqual([expect.stringMatching(/^claim \^c[0-9a-z]{6}$/)]);
    const st = topicState(topicFile(t, "Auth design"));
    expect(st.claims).toEqual([{ id: expect.stringMatching(/^c/), text: "Enterprise users sign in through Okta (SAML).", since: "2026-10-08", source: expect.stringMatching(/^\[\[2026-10-08T/) }]);
  });

  it("moves a replaced claim to History with the day it ended, and keeps ids stable", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = workDay(t, "2026-10-08");
    s.topic({ name: "Auth design", force: true, update: { claims: [{ text: "Everyone signs in with magic links." }] } });
    const old = topicState(topicFile(t, "Auth design")).claims[0]!;
    t.at("2026-10-12T10:00:00+02:00");
    const s2 = t.atlas.session({ cwd: t.cwd("alpha") });
    s2.topic({ name: "Auth design", update: { claims: [{ text: "Enterprise users sign in through Okta.", replaces: old.id }] } });
    const st = topicState(topicFile(t, "Auth design"));
    expect(st.claims.map((c) => [c.text, c.since])).toEqual([["Enterprise users sign in through Okta.", "2026-10-12"]]);
    expect(st.history).toEqual([expect.objectContaining({ id: old.id, text: "Everyone signs in with magic links.", since: "2026-10-08", until: "2026-10-12" })]);
    expect(st.history[0]!.detail).toContain(`replaced by ^${st.claims[0]!.id}`);
  });

  it("opens and resolves items, and closes claims with nothing replacing them", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = workDay(t, "2026-10-08");
    s.topic({ name: "Exports", force: true, update: { claims: [{ text: "The legacy CSV export runs nightly." }], open: ["Email the two CSV tenants."] } });
    let st = topicState(topicFile(t, "Exports"));
    s.topic({ name: "Exports", update: { close: [st.claims[0]!.id], resolve: [{ id: st.open[0]!.id, how: "Both moved to the API." }] } });
    st = topicState(topicFile(t, "Exports"));
    expect(st.claims).toEqual([]);
    expect(st.open).toEqual([]);
    expect(st.history.map((h) => h.detail)).toEqual(["since 2026-10-08, until 2026-10-08", "open 2026-10-08, resolved 2026-10-08: Both moved to the API."]);
  });

  it("refuses an unknown id or a future day and writes nothing", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = workDay(t, "2026-10-08");
    s.topic({ name: "Auth design", force: true, update: { claims: [{ text: "A." }] } });
    const before = topicFile(t, "Auth design");
    expect(() => s.topic({ name: "Auth design", update: { claims: [{ text: "B." }], close: ["cnope00"] } })).toThrow(/no current claim \^cnope00/);
    expect(() => s.topic({ name: "Auth design", update: { claims: [{ text: "B.", since: "2026-12-01" }] } })).toThrow(/future/);
    expect(topicFile(t, "Auth design")).toBe(before);
  });

  it("keeps prose and lines a person wrote", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = workDay(t, "2026-10-08");
    s.topic({ name: "Auth design", force: true, update: { state: "We moved off passwords in 2025." } });
    s.topic({ name: "Auth design", update: { claims: [{ text: "Okta for SSO." }] } });
    const body = topicFile(t, "Auth design");
    expect(body).toMatch(/## What we know now\n\nWe moved off passwords in 2025.\n- Okta for SSO. \(since 2026-10-08/);
  });

  it("parses lines with parentheses in the text", () => {
    const line = renderClaim({ id: "cabc123", text: "Retries are idempotent (invoice_id + version).", since: "2026-10-08", source: "[[x]]" });
    expect(parseClaim(line)).toEqual({ id: "cabc123", text: "Retries are idempotent (invoice_id + version).", since: "2026-10-08", source: "[[x]]" });
    expect(parseOpen("- Load test 10k invoices. (open since 2026-10-08) ^o12ab34")).toMatchObject({ id: "o12ab34", since: "2026-10-08" });
    expect(parseHistory("- ~~Old.~~ (since 2026-10-01, until 2026-10-08, replaced by ^cabc123) ^c999999")).toMatchObject({ since: "2026-10-01", until: "2026-10-08" });
  });
});

describe("claims written by rollups", () => {
  it("dates a rollup's claims within its period, cites the day note, and lists ids to the next writer", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    workDay(t, "2026-10-08", [["decision", "Okta for enterprise sign-in"]]);
    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.summarize({ period: "2026-10-08" });
    const r = s.seal({
      period: "2026-10-08",
      headline: "Chose Okta",
      content: "### What happened\n- Chose Okta.",
      topicUpdates: [{ name: "Auth design", claims: [{ text: "Enterprise users sign in through Okta." }], open: ["Decide the SAML session lifetime."] }],
    });
    expect(r.topics[0]).toMatch(/^Auth design \(claim \^c\w+, open \^o\w+\)$/);
    const st = topicState(topicFile(t, "Auth design"));
    expect(st.claims[0]).toMatchObject({ since: "2026-10-08", source: "[[2026-10-08 alpha]]" });

    workDay(t, "2026-10-09");
    t.at("2026-10-10T09:00:00+02:00");
    const next = t.atlas.session({ cwd: t.cwd("alpha") }).summarize({ period: "2026-10-09" });
    expect(next.sources).toContain("## Topics in this scope");
    expect(next.sources).toContain(`^${st.claims[0]!.id} Enterprise users sign in through Okta.`);
    expect(next.instructions).toContain("replaces");
  });

  it("refuses the whole seal when a topic update names an unknown id or a day outside the period", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    workDay(t, "2026-10-08");
    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.summarize({ period: "2026-10-08" });
    const base = { period: "2026-10-08", headline: "H", content: "### What happened\n- x." };
    expect(() => s.seal({ ...base, topicUpdates: [{ name: "Auth", resolve: [{ id: "o000000" }] }] })).toThrow(/topic_updates for "Auth".*no open item/);
    expect(() => s.seal({ ...base, topicUpdates: [{ name: "Auth", claims: [{ text: "x", since: "2026-10-01" }] }] })).toThrow(/outside the period/);
    expect(s.pending().items.map((i) => i.period)).toContain("2026-10-08");
  });

  it("applies a tidy reply's topics block, and seals without it when the block is bad", async () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    workDay(t, "2026-10-05");
    workDay(t, "2026-10-06");
    t.at("2026-10-07T09:00:00+02:00");
    const runner: ModelRunner = async (prompt) => {
      const period = /# Sources for (\S+)/.exec(prompt)?.[1];
      const block = period === "2026-10-05" ? '[{"name": "Billing", "claims": [{"text": "Prorate by the day."}]}]' : '[{"name": "Billing", "close": ["cnothere"]}]';
      return { text: `Headline: ${period}\n\n### What happened\n- Work.\n\n\`\`\`topics\n${block}\n\`\`\``, costUsd: 0.01, inputTokens: 100, outputTokens: 20 };
    };
    const report = await tidy(t.atlas, { runner, model: "haiku", maxTokens: 1e6, maxUsd: 1 });
    const byDay = Object.fromEntries(report.outcomes.map((o) => [o.period, o]));
    expect(byDay["2026-10-05"]).toMatchObject({ result: "sealed", topics: [expect.stringMatching(/^Billing \(claim/)] });
    expect(byDay["2026-10-06"]).toMatchObject({ result: "sealed", warning: expect.stringMatching(/topic updates skipped/) });
    expect(topicState(topicFile(t, "Billing")).claims.map((c) => [c.text, c.since])).toEqual([["Prorate by the day.", "2026-10-05"]]);
  });
});

describe("the brief", () => {
  it("shows recent todos until a rollup carries them into a topic, and what changed this week", () => {
    const t = setup("2026-10-05T10:00:00+02:00");
    workDay(t, "2026-10-05", [["todo", "Load test with 10k invoices."]]);
    workDay(t, "2026-10-06", [["todo", "Ask Dana about credit notes."]]);
    t.at("2026-10-07T09:00:00+02:00");
    let brief = t.atlas.session({ cwd: t.cwd("alpha") }).brief();
    expect(brief).toContain("## Open\n- Ask Dana about credit notes. (logged 2026-10-06)\n- Load test with 10k invoices. (logged 2026-10-05)");

    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.summarize({ period: "2026-10-05" });
    s.seal({
      period: "2026-10-05",
      headline: "Load testing",
      content: "### What happened\n- Planned the load test.",
      topicUpdates: [{ name: "Invoicing", claims: [{ text: "Invoices render on a queue." }], open: ["Load test with 10k invoices before release."] }],
    });
    brief = t.atlas.session({ cwd: t.cwd("alpha") }).brief();
    expect(brief).toContain("- Load test with 10k invoices before release. (since 2026-10-05, [[Invoicing]])");
    expect(brief).not.toContain("(logged 2026-10-05)");
    expect(brief).toContain("- Ask Dana about credit notes. (logged 2026-10-06)");
    expect(brief).toContain("## Changed this week\n- [[Invoicing]]: Invoices render on a queue.");
  });
});
