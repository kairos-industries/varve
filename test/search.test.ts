import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Embedder, modelInstalled, preTokenize, pullModel } from "../src/embed/index.js";
import { chunks } from "../src/search.js";
import { setup } from "./helpers.js";

/** A model2vec model small enough to write by hand: each word gets a direction, synonyms share one. */
function tinyModel(words: Record<string, number[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "atlas-model-"));
  const vocab: Record<string, number> = { "[UNK]": 0 };
  const rows: number[][] = [[0, 0, 0, 0]];
  for (const [w, v] of Object.entries(words)) {
    vocab[w] = rows.length;
    rows.push(v);
  }
  writeFileSync(join(dir, "tokenizer.json"), JSON.stringify({ model: { type: "WordPiece", unk_token: "[UNK]", vocab } }));
  const data = Buffer.from(new Float32Array(rows.flat()).buffer);
  const header = Buffer.from(JSON.stringify({ embeddings: { dtype: "F32", shape: [rows.length, 4], data_offsets: [0, data.length] } }));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  writeFileSync(join(dir, "model.safetensors"), Buffer.concat([len, header, data]));
  return dir;
}

const WORDS = {
  login: [1, 0, 0, 0],
  sso: [0.95, 0.1, 0, 0],
  okta: [0.9, 0, 0.1, 0],
  sign: [0.8, 0, 0, 0.2],
  invoice: [0, 1, 0, 0],
  queue: [0, 0.2, 1, 0],
  "##s": [0, 0, 0, 0.1],
};

describe("embeddings", () => {
  it("tokenizes like BERT: lower case, no accents, punctuation apart", () => {
    expect(preTokenize("Décidé: SSO-login, v2!")).toEqual(["decide", ":", "sso", "-", "login", ",", "v2", "!"]);
  });

  it("averages word vectors into a unit vector, splitting words into pieces and dropping unknown ones", () => {
    const e = new Embedder(tinyModel(WORDS));
    expect(e.tokenize("Invoices zebra")).toEqual([5, 7]);
    const v = e.embed("login")!;
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    expect(e.embed("zebra")).toBeUndefined();
  });

  it("refuses model files that do not match the pinned hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-pull-"));
    const fake = (async () => new Response("not the model")) as unknown as typeof fetch;
    await expect(pullModel(dir, fake)).rejects.toThrow(/pinned hash/);
    expect(modelInstalled(dir)).toBe(false);
  });
});

describe("search by meaning", () => {
  function atlas() {
    const t = setup("2026-10-08T10:00:00+02:00");
    const s = t.atlas.session({ cwd: t.cwd("alpha") });
    s.log({ type: "decision", text: "Use Okta SSO for the admin console." });
    s.closeSession({ headline: "Admin console auth", summary: "### Done\n- Okta SSO wired in." });
    const s2 = t.atlas.session({ cwd: t.cwd("alpha") });
    s2.log({ type: "change", text: "Invoice rendering moved to a queue." });
    return { t, s: t.atlas.session({ cwd: t.cwd("alpha") }) };
  }

  it("finds a note by meaning when no word matches, and says so", () => {
    const { s } = atlas();
    const embedder = new Embedder(tinyModel(WORDS));
    expect(s.search({ query: "login" }, { mode: "keyword" })).toEqual([]);
    const hits = s.search({ query: "login" }, { embedder });
    expect(hits[0]).toMatchObject({ layer: "session", match: "meaning" });
    expect(hits[0]!.snippet).toContain("Okta SSO");
    expect(hits.some((h) => h.snippet.includes("Invoice"))).toBe(false);
  });

  it("ranks a note matched by keyword and by meaning first", () => {
    const { s } = atlas();
    const hits = s.search({ query: "okta sign" }, { embedder: new Embedder(tinyModel(WORDS)) });
    expect(hits[0]).toMatchObject({ match: "both" });
  });

  it("stays keyword only without a model, and says how to get one when meaning is asked for", () => {
    const { s } = atlas();
    expect(s.search({ query: "okta" })[0]).toMatchObject({ match: "keyword" });
    expect(() => s.search({ query: "okta" }, { mode: "semantic" })).toThrow(/models pull/);
  });
});

describe("chunks", () => {
  it("splits on paragraphs and list items and merges small pieces", () => {
    const text = "# Day\n\nShipped [[2026-10-08 alpha|the export]].\n\n- one\n- two\n\n---\n\n" + "word ".repeat(70);
    const c = chunks(text);
    expect(c[0]).toBe("Day\nShipped the export.\n- one\n- two");
    expect(c).toHaveLength(2);
  });
});

