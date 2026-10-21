import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeNote } from "../src/store/note.js";
import { setup } from "./helpers.js";

const DAY = "scopes/alpha/days/2026/2026-10-08 alpha.md";
const WEEK = "scopes/alpha/weeks/2026/2026-W41 alpha.md";

/** One worked day, sealed, then its week sealed, observed from Monday 2026-10-12. */
function sealedWeek() {
  const t = setup("2026-10-08T10:00:00+02:00");
  const work = t.atlas.session({ cwd: t.cwd("alpha") });
  work.closeSession({ headline: "Parser", summary: "Built the parser." });
  t.at("2026-10-12T09:00:00+02:00");
  const s = t.atlas.session({ cwd: t.cwd("alpha") });
  s.seal({ period: "2026-10-08", headline: "Parser built", content: "Parser built with 3 passes." });
  s.seal({ period: "2026-W41", headline: "Parser week", content: "A week of parsing." });
  expect(s.pending().items.map((i) => i.period)).toEqual([]);
  return { t, s };
}

describe("human edits", () => {
  it("keeps a hand-edited sealed note and marks the notes built on it stale", () => {
    const { t, s } = sealedWeek();
    t.write(DAY, t.read(DAY).replace("3 passes", "4 passes"));

    const items = s.pending().items;
    expect(items.map((i) => [i.period, i.stale])).toEqual([["2026-W41", true]]);
    expect(t.read(DAY)).toContain("4 passes");
    expect(t.read(WEEK)).toContain("status: stale");
  });

  it("stops regenerating a draft a human edited and feeds the edit to the rollup", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const a = t.atlas.session({ cwd: t.cwd("alpha") });
    a.closeSession({ headline: "Morning", summary: "m" });
    t.write(DAY, `${t.read(DAY)}\nHuman note: the client call moved to Friday.\n`);

    t.at("2026-10-08T15:00:00+02:00");
    t.atlas.session({ cwd: t.cwd("alpha") }).closeSession({ headline: "Afternoon", summary: "a" });
    expect(t.read(DAY)).toContain("client call moved");

    t.at("2026-10-09T09:00:00+02:00");
    const job = t.atlas.session({ cwd: t.cwd("alpha") }).summarize({ period: "2026-10-08" });
    expect(job.sources).toContain("client call moved to Friday");
    expect(job.sources).toContain("Afternoon");
  });
});

describe("amendments", () => {
  it("appends a dated amendment and marks the parents stale", () => {
    const { t, s } = sealedWeek();
    const result = s.amend({ note: "2026-10-08", change: "It was 4 passes, not 3.", reason: "Miscounted" });
    expect(result.nowStale).toEqual(["2026-W41"]);
    const day = t.read(DAY);
    expect(day).toContain("## Amendments");
    expect(day).toContain("- 2026-10-12: It was 4 passes, not 3. (Reason: Miscounted)");
    expect(day).toContain("status: sealed");
  });

  it("re-rolls a stale week from the amended day and keeps the previous version", () => {
    const { t, s } = sealedWeek();
    s.amend({ note: "2026-10-08", change: "It was 4 passes.", reason: "Miscounted" });
    const job = s.summarize({ period: "2026-W41" });
    expect(job.sources).toContain("It was 4 passes.");
    s.seal({ period: "2026-W41", headline: "Parser week, corrected", content: "A week of parsing, 4 passes." });

    const week = t.read(WEEK);
    expect(week).toContain("status: sealed");
    expect(week).toContain("4 passes");
    expect(week).toContain("## Previous version");
    expect(week).toContain("A week of parsing.");
  });

  it("refuses to amend a draft", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.closeSession({ headline: "x", summary: "y" });
    expect(() => s.amend({ note: "2026-10-08", change: "c", reason: "r" })).toThrow(/draft/);
  });
});

function transcript(dir: string, chars: number) {
  const path = join(dir, "transcript.jsonl");
  const lines = [
    { type: "user", message: { role: "user", content: "Please refactor the billing export." } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(chars) }, { type: "tool_use", name: "Bash" }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "SECRET TOOL OUTPUT" }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

/** A session note as v0.1 hooks wrote it: no events, no summary, only a transcript path. */
function legacyOrphan(t: ReturnType<typeof setup>, transcriptPath: string) {
  const path = join(t.dir, "scopes/alpha/sessions/2026/10/2026-10-08T1000-old001.md");
  writeNote(
    path,
    { atlas: "session", scope: "alpha", session: "old001", started: "2026-10-08T10:00:00+02:00", ended: "2026-10-08T11:00:00+02:00", status: "closed", transcript: transcriptPath, days: ["2026-10-08"] },
    "# Session 2026-10-08 10:00\n\nRecorded by a hook only. Summarize it from its transcript.\n",
  );
  return path;
}

describe("orphan sessions from before activity capture", () => {
  it("can be summarized from the transcript, and no day waits for them", () => {
    const t = setup("2026-10-08T10:00:00+02:00");
    legacyOrphan(t, transcript(t.root, 3000));
    t.at("2026-10-09T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    const items = s.pending().items;
    expect(items.map((i) => [i.layer, i.blocked])).toEqual([["session", false]]);

    const job = s.summarize({ period: "old001" });
    expect(job.sources).toContain("refactor the billing export");
    expect(job.sources).not.toContain("SECRET TOOL OUTPUT");
    s.seal({ period: "old001", headline: "Refactored billing export", content: "Split the exporter." });
    expect(s.pending().items.map((i) => i.period)).toContain("2026-10-08");
    expect(s.summarize({ period: "2026-10-08" }).sources).toContain("Refactored billing export");
  });

  it("does not hold up a week whose other days are ready", () => {
    const t = setup("2026-10-06T10:00:00+02:00");
    const a = t.atlas.session({ cwd: t.cwd("alpha") });
    a.closeSession({ headline: "Tuesday work", summary: "Done." });
    legacyOrphan(t, transcript(t.root, 3000));
    t.at("2026-10-13T09:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.seal({ period: "2026-10-06", headline: "Tuesday", content: "Work." });
    const week = s.pending().items.find((i) => i.period === "2026-W41")!;
    expect(week.blocked).toBe(false);
  });
});
