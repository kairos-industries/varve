import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("topics", () => {
  it("reports a missing topic", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    expect(t.atlas.session({ cwd: t.cwd("alpha") }).topic({ name: "Auth design" })).toMatchObject({ exists: false });
  });

  it("creates a topic with its current state and a dated timeline entry", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.log({ type: "decision", text: "JWT with 15 minute expiry" });
    const r = s.topic({ name: "Auth design", update: { state: "JWT access tokens, 15 minute expiry.", entry: "Chose JWT." } });
    expect(r.created).toBe(true);
    const text = t.read("scopes/alpha/topics/Auth design.md");
    expect(text).toMatch(/## What we know now\n\nJWT access tokens, 15 minute expiry\./);
    expect(text).toMatch(/## Timeline\n\n- 2026-10-08 Chose JWT\. \[\[2026-10-08T1000-[a-z0-9]{6}\]\]/);
    expect(s.topic({ name: "auth design" }).content).toContain("15 minute expiry");
  });

  it("offers an existing topic with a similar name instead of creating a duplicate", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.topic({ name: "Auth design", update: { state: "JWT." } });
    const r = s.topic({ name: "Authentication design", update: { state: "Sessions." } });
    expect(r).toMatchObject({ created: false, similar: ["Auth design"] });
    expect(s.topic({ name: "Authentication design", update: { state: "Sessions." }, force: true }).created).toBe(true);
  });

  it("keeps human-added sections when updating", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.topic({ name: "Auth design", update: { state: "JWT." } });
    const path = "scopes/alpha/topics/Auth design.md";
    t.write(path, `${t.read(path)}\n## My notes\n\nAsk Dana about SSO.\n`);
    s.topic({ name: "Auth design", update: { state: "JWT with refresh tokens.", entry: "Added refresh." } });
    const text = t.read(path);
    expect(text).toContain("Ask Dana about SSO.");
    expect(text).toContain("JWT with refresh tokens.");
    expect(text).not.toMatch(/What we know now\n\nJWT\.\n/);
  });

  it("applies topic updates proposed in a seal, linking the period note", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("alpha") }).closeSession({ headline: "Auth", summary: "x" });
    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.seal({ period: "2026-10-08", headline: "Auth decided", content: "x", topicUpdates: [{ name: "Auth design", entry: "Settled on JWT.", state: "JWT." }] });
    expect(t.read("scopes/alpha/topics/Auth design.md")).toContain("- 2026-10-09 Settled on JWT. [[2026-10-08 alpha]]");
  });

  it("falls back to general topics and hides isolated ones", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    t.atlas.session({}).topic({ name: "Writing style", update: { state: "No em dashes." } });
    expect(t.atlas.session({ cwd: t.cwd("alpha") }).topic({ name: "Writing style" }).content).toContain("No em dashes");

    const x = t.atlas.session({ cwd: t.cwd("client-x") });
    x.scopes({ set: { scope: "client-x", isolated: true } });
    x.topic({ name: "Pricing", update: { state: "Secret." } });
    expect(() => t.atlas.session({ cwd: t.cwd("alpha") }).topic({ name: "Pricing", scope: "client-x" })).toThrow(/isolated/);
  });
});

describe("scope management", () => {
  it("maps the current folder to an existing scope for future sessions", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("beta") });
    expect(s.scope).toBe("beta");
    s.scopes({ set: { scope: "alpha", mapHere: true } });
    expect(s.scope).toBe("alpha");
    expect(t.atlas.session({ cwd: t.cwd("beta") }).scope).toBe("alpha");
  });

  it("merges one scope into another, moving sessions and marking overlapping sealed notes stale", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("alpha") }).closeSession({ headline: "Alpha work", summary: "a" });
    t.atlas.session({ cwd: t.cwd("beta") }).closeSession({ headline: "Beta work", summary: "b" });
    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.seal({ period: "2026-10-08", headline: "Alpha day", content: "a" });

    s.scopes({ set: { scope: "beta", mergeInto: "alpha" } });
    expect(t.files("scopes/beta")).toEqual([]);
    expect(t.files("scopes/alpha/sessions")).toHaveLength(2);
    expect(s.pending().items.map((i) => [i.period, i.stale])).toEqual([["2026-10-08", true]]);
    expect(s.summarize({ period: "2026-10-08" }).sources).toContain("Beta work");
    expect(t.atlas.session({ cwd: t.cwd("beta") }).scope).toBe("alpha");
  });

  it("rewrites links to the period notes it renames, without counting that as a person's edit", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const b = t.atlas.session({ cwd: t.cwd("beta") });
    b.log({ type: "decision", text: "Keep the ledger in Postgres." });
    b.closeSession({ headline: "Beta work", summary: "b" });
    t.at("2026-10-13T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("beta") });
    s.seal({ period: "2026-10-08", headline: "Beta day", content: "b" });
    s.seal({ period: "2026-W41", headline: "Beta week", content: "Built on [[2026-10-08 beta]]." });
    s.topic({ name: "Ledger", update: { entry: "Decided on [[2026-10-08 beta|Thursday]]." } });

    s.scopes({ set: { scope: "beta", mergeInto: "gamma" } });
    const all = t.files().map((f) => t.read(f)).join("\n");
    expect(all).not.toMatch(/\[\[[^\]]* beta(\|[^\]]*)?\]\]/);
    expect(t.read("scopes/gamma/weeks/2026/2026-W41 gamma.md")).toContain('"[[2026-10-08 gamma]]"');
    expect(t.read("scopes/gamma/weeks/2026/2026-W41 gamma.md")).toContain("Built on [[2026-10-08 gamma]].");
    expect(t.read("scopes/gamma/topics/Ledger.md")).toContain("[[2026-10-08 gamma|Thursday]]");
    // The week is still sealed and nothing above it went stale.
    expect(t.atlas.session({ cwd: t.cwd("beta") }).pending().items.filter((i) => i.stale)).toEqual([]);
  });

  it("maps only the folders that belonged to the merged scope, not sessions moved into it", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("beta") }).closeSession({ headline: "Beta work", summary: "b" });
    // Started in alpha's folder, then filed under beta by hand.
    const moved = t.atlas.session({ cwd: t.cwd("alpha") });
    moved.log({ type: "note", text: "This is beta work.", scope: "beta" });
    moved.closeSession({ headline: "Beta prep from alpha", summary: "b" });

    t.atlas.session({ cwd: t.cwd("client-x") }).scopes({ set: { scope: "beta", mergeInto: "gamma" } });
    expect(t.atlas.session({ cwd: t.cwd("beta") }).scope).toBe("gamma");
    expect(t.atlas.session({ cwd: t.cwd("alpha") }).scope).toBe("alpha");
  });
});

describe("day change during a session", () => {
  it("asks the agent to summarize yesterday's segment, once", () => {
    const t = setup("2026-10-07T22:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.log({ type: "change", text: "Evening work" });
    expect(s.checkpoint()).toBeUndefined();
    t.at("2026-10-08T09:00:00+02:00");
    const notice = s.checkpoint();
    expect(notice).toContain("2026-10-07");
    expect(notice).toContain('segment: "2026-10-07"');
    expect(s.checkpoint()).toBeUndefined();
  });
});
