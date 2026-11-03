import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Static text embeddings (model2vec, potion-base-8M) in plain TypeScript: a BERT WordPiece
 * tokenizer and one row of a 29,528 x 256 matrix per token, averaged. No native code and no
 * network at search time; the model is fetched once by `temporal-atlas models pull`.
 */

export const MODEL = {
  name: "potion-base-8M",
  repo: "minishlab/potion-base-8M",
  /** Pinned revision, so every atlas embeds with the same weights and benchmark results compare. */
  revision: "bf8b056651a2c21b8d2565580b8569da283cab23",
  files: {
    "tokenizer.json": "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50",
    "model.safetensors": "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2",
  } as Record<string, string>,
  licence: "MIT",
};

/** Where models are kept: shared by every atlas on the machine, outside the notes. */
export function modelsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEMPORAL_ATLAS_MODELS) return env.TEMPORAL_ATLAS_MODELS;
  const base = env.XDG_CACHE_HOME || (process.platform === "win32" && env.LOCALAPPDATA) || join(homedir(), ".cache");
  return join(base, "temporal-atlas", "models");
}

export function modelDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(modelsDir(env), MODEL.name);
}

export function modelInstalled(dir = modelDir()): boolean {
  return Object.keys(MODEL.files).every((f) => existsSync(join(dir, f)));
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** Download the pinned model files and check their hashes. Returns the bytes fetched. */
export async function pullModel(dir = modelDir(), fetchImpl: typeof fetch = fetch, log: (line: string) => void = () => {}): Promise<number> {
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const [file, hash] of Object.entries(MODEL.files)) {
    const target = join(dir, file);
    if (existsSync(target) && sha256(readFileSync(target)) === hash) continue;
    const url = `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${file}`;
    log(`Fetching ${url}`);
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Could not fetch ${file}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== hash) throw new Error(`${file} does not match the pinned hash; nothing was saved.`);
    writeFileSync(`${target}.part`, buf);
    renameSync(`${target}.part`, target);
    bytes += buf.length;
  }
  return bytes;
}

// ---- tokenizer ----

const CONTROL = /[\u0000�]|[\p{Cc}\p{Cf}]/gu;
const PUNCT = /[\p{P}$+<=>^`|~]/u;
const CJK = /[一-鿿㐀-䶿\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}豈-﫿\u{2f800}-\u{2fa1f}]/gu;

/** BertNormalizer with lowercase (which also strips accents) and BertPreTokenizer: words and single punctuation marks. */
export function preTokenize(text: string): string[] {
  const clean = text
    .replace(/[\t\n\r]/g, " ")
    .replace(CONTROL, "")
    .replace(CJK, (c) => ` ${c} `)
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase();
  const out: string[] = [];
  for (const word of clean.split(/\s+/)) {
    let current = "";
    for (const ch of word) {
      // ASCII symbols count as punctuation for BERT, as do Unicode P* characters.
      const code = ch.codePointAt(0)!;
      const ascii = (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
      if (ascii || PUNCT.test(ch)) {
        if (current) out.push(current);
        out.push(ch);
        current = "";
      } else current += ch;
    }
    if (current) out.push(current);
  }
  return out;
}

export class Embedder {
  readonly dim: number;
  private readonly vocab: Map<string, number>;
  private readonly unk: number;
  private readonly matrix: Float32Array;

  constructor(dir = modelDir()) {
    const tok = JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as { model: { vocab: Record<string, number>; unk_token: string } };
    this.vocab = new Map(Object.entries(tok.model.vocab));
    this.unk = this.vocab.get(tok.model.unk_token) ?? -1;
    const raw = readFileSync(join(dir, "model.safetensors"));
    const headerLen = Number(raw.readBigUInt64LE(0));
    const header = JSON.parse(raw.subarray(8, 8 + headerLen).toString("utf8")) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
    const t = header.embeddings;
    if (!t || t.dtype !== "F32" || t.shape.length !== 2) throw new Error("model.safetensors has no F32 embeddings matrix.");
    const start = 8 + headerLen + t.data_offsets[0];
    // Copy into an aligned buffer: the data offset need not be a multiple of 4.
    this.matrix = new Float32Array(raw.buffer.slice(raw.byteOffset + start, raw.byteOffset + 8 + headerLen + t.data_offsets[1]));
    this.dim = t.shape[1]!;
  }

  /** WordPiece ids for a text, without special tokens and without [UNK] (model2vec drops them). */
  tokenize(text: string): number[] {
    const ids: number[] = [];
    for (const word of preTokenize(text)) {
      if (word.length > 100) continue;
      const pieces: number[] = [];
      let start = 0;
      let ok = true;
      while (start < word.length) {
        let end = word.length;
        let found = -1;
        while (end > start) {
          const piece = (start > 0 ? "##" : "") + word.slice(start, end);
          const id = this.vocab.get(piece);
          if (id !== undefined) {
            found = id;
            break;
          }
          end--;
        }
        if (found < 0) {
          ok = false;
          break;
        }
        pieces.push(found);
        start = end;
      }
      if (ok) ids.push(...pieces.filter((id) => id !== this.unk));
    }
    return ids;
  }

  /** The unit-length mean embedding of a text, or undefined when no token is known. At most 512 tokens are used, as in model2vec. */
  embed(text: string): Float32Array | undefined {
    const ids = this.tokenize(text).slice(0, 512);
    if (!ids.length) return undefined;
    const v = new Float32Array(this.dim);
    for (const id of ids) {
      const row = id * this.dim;
      for (let i = 0; i < this.dim; i++) v[i]! += this.matrix[row + i]!;
    }
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dim; i++) v[i]! /= norm;
    return v;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

let loaded: { dir: string; embedder?: Embedder } | undefined;

/** The embedder for the installed model, loaded once per process, or undefined when the model is not installed. */
export function embedder(dir = modelDir()): Embedder | undefined {
  if (loaded?.dir === dir) return loaded.embedder;
  loaded = { dir, embedder: modelInstalled(dir) ? new Embedder(dir) : undefined };
  return loaded.embedder;
}
