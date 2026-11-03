import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { benchFixture, benchOwn, bootstrap, eventQuery, ownProbes, paraphrase } from "../src/bench/index.js";
import { ALL_FIXTURE_QUESTIONS, FIXTURE_SESSIONS } from "../src/bench/fixture.js";
import { allScopes } from "../src/periods.js";
import { listMarkdown } from "../src/store/note.js";
import type { ModelRunner } from "../src/tidy/index.js";
import { setup } from "./helpers.js";

/** Every string anywhere in a report. */
function strings(o: unknown): string[] {
  if (typeof o === "string") return [o];
  if (Array.isArray(o)) return o.flatMap(strings);
  if (o && typeof o === "object") return Object.values(o).flatMap(strings);
  return [];
}

const ALLOWED = /^(temporal-atlas|fixture|own|own-paraphrased|\d{4}-\d{2}-\d{2}|aix|darwin|freebsd|linux|openbsd|sunos|win32|[\d.]+|potion-base-8M|[0-9a-f]{40}|haiku|sonnet)$/;

function worked() {
  const t = setup("2026-10-08T10:00:00+02:00");
  const s = t.atlas.session({ cwd: t.cwd("alpha") });
  s.log({ type: "decision", text: "Keep the ledger in Postgres because the audit team reads it with SQL." });
  s.log({ type: "todo", text: "Ask Dana about the credit note queue." });
  s.closeSession({ headline: "Ledger storage", summary: "### Done\n- Ledger stays in Postgres." });
  const b = t.atlas.session({ cwd: t.cwd("client-x") });
  b.log({ type: "finding", text: "The Acme merger moves the fiscal year end to March for every subsidiary." });
  b.closeSession({ headline: "Acme merger", summary: "### Done\n- Fiscal year notes." });
  return t;
}

describe("benchmark", () => {
  it("scores the fixture the same way on every machine", () => {
    const r = benchFixture(undefined);
    expect(r.dataset).toBe("fixture");
    expect(r.atlas.sessions).toBe(FIXTURE_SESSIONS.length);
    expect(r.retrieval.all!.probes).toBe(ALL_FIXTURE_QUESTIONS.length);
    expect(r.retrieval.dev!.probes + r.retrieval.test!.probes).toBe(ALL_FIXTURE_QUESTIONS.length);
    // Exact names are found first: day, week and month drafts must not crowd out the session.
    expect(r.retrieval["dev/exact"]!.keyword!.hit1).toBe(1);
    expect(r.model).toBeNull();
    expect(r.retrieval.all!.hybrid).toBeUndefined();
    expect(withoutMs(benchFixture(undefined).retrieval)).toEqual(withoutMs(r.retrieval));
    // Building the fixture twice writes about 50 notes through the real code path; Windows CI is slow at that.
  }, 60_000);

  it("builds probes from logged events, each searched in its own scope", () => {
    const t = worked();
    const probes = ownProbes(t.atlas, allScopes(t.atlas));
    expect(probes).toHaveLength(2);
    const ledger = probes.find((p) => p.query.startsWith("Keep the ledger"))!;
    expect(ledger).toMatchObject({ kind: "event", scopes: ["alpha"] });
    expect(probes.some((p) => p.query.includes("Dana"))).toBe(false);
  });

  it("reports numbers only: no note text, no scope or note names", () => {
    const t = worked();
    const r = benchOwn(t.atlas, { sweep: true });
    for (const s of strings(r)) expect(s).toMatch(ALLOWED);
    expect(Object.keys(r.retrieval)).toEqual(["event", "all"]);
    expect(r.retrieval.event!.keyword!.hit1).toBe(1);
    expect(r.brief).toMatchObject({ scopes: 2, todos: 1 });
  });

  it("only reads the atlas", () => {
    const t = worked();
    const files = () => listMarkdown(t.dir).map((p) => `${p}:${statSync(p).mtimeMs}:${readFileSync(p, "utf8").length}`);
    const before = files();
    benchOwn(t.atlas);
    expect(files()).toEqual(before);
  });

  it("gives the same bootstrap interval on every run, around the mean", () => {
    const values = [0, 1, 0.5, 1, 0, 0.25, 1, 1, 0, 0.33];
    const ci = bootstrap(values);
    expect(bootstrap(values)).toEqual(ci);
    expect(ci[0]).toBeLessThan(0.508);
    expect(ci[1]).toBeGreaterThan(0.508);
    expect(bootstrap([1, 1, 1])).toEqual([1, 1]);
  });

  it("cuts an event to a query someone might type", () => {
    expect(eventQuery("Use half-up in every money calculation; it matches the ledger.")).toBe("Use half-up in every money calculation");
    expect(eventQuery("Retry key is invoice_id plus version, so a re-render is not deduplicated.")).toBe("Retry key is invoice_id plus version");
  });

  it("paraphrases in batches within the budget and skips replies it cannot read", async () => {
    const probes = Array.from({ length: 60 }, (_, i) => ({ query: `query ${i}`, relevant: ["x"], kind: "event", scopes: ["alpha"] }));
    const prompts: string[] = [];
    let call = 0;
    const runner: ModelRunner = async (prompt, opts) => {
      prompts.push(prompt);
      expect(opts.maxUsd).toBeGreaterThan(0);
      call++;
      const lines = prompt.split("\n\n").at(-1)!.split("\n");
      if (call === 2) return { text: "sorry", costUsd: 0.01 };
      return { text: JSON.stringify(lines.map((l) => `reworded ${l}`)), costUsd: 0.01 };
    };
    const r = await paraphrase(probes, runner, { model: "haiku", maxUsd: 1 });
    expect(prompts).toHaveLength(3);
    expect(r.probes).toHaveLength(35);
    expect(r.probes[0]!.query).toBe("reworded query 0");
    expect(r.costUsd).toBeCloseTo(0.03);

    const capped = await paraphrase(probes, async () => ({ text: "[]", costUsd: 0.2 }), { model: "haiku", maxUsd: 0.2 });
    expect(capped.costUsd).toBeCloseTo(0.2);
  });
});

/** Timings differ between runs; nothing else may. */
const withoutMs = (r: object) => JSON.parse(JSON.stringify(r, (k, v) => (k === "ms" ? undefined : v)));
