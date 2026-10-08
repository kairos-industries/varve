import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas } from "../src/atlas.js";
import { listMarkdown } from "../src/store/note.js";

/** A throwaway atlas in a temp dir, with a clock the test controls. Times are Madrid local. */
export function setup(start: string) {
  const root = mkdtempSync(join(tmpdir(), "atlas-test-"));
  const dir = join(root, "atlas");
  for (const name of ["alpha", "beta", "client-x"]) mkdirSync(join(root, "work", name), { recursive: true });
  let now = new Date(start);
  const atlas = new Atlas({ dir, clock: () => now, config: { timezone: "Europe/Madrid" } });
  return {
    atlas,
    dir,
    at(iso: string) {
      now = new Date(iso);
    },
    cwd: (name: string) => join(root, "work", name),
    files: (sub = "") => listMarkdown(join(dir, sub)).map((p) => p.slice(dir.length + 1)),
    read: (rel: string) => readFileSync(join(dir, rel), "utf8"),
    write: (rel: string, text: string) => writeFileSync(join(dir, rel), text),
    root,
  };
}
