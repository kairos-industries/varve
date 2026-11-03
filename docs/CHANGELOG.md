# Changelog

## 0.5.0

Temporal Atlas is now **Varve**, and topic notes hold dated claims and open items, so the atlas is organized by topic as well as by time.

### Added

- **Claims, open items and history in topics.** Each line in a topic note has the day it started, the note it came from and an Obsidian block id. A replaced or closed claim, and a resolved item, moves to History with the day it ended; nothing is deleted. `seal`'s `topic_updates` and `topic` updates take `claims` (with `replaces`), `close`, `open` and `resolve`, and the server checks every id and day before writing. Rollup writers see the scope's current claims and open items with their ids. `tidy` reads them from a fenced `topics` block at the end of the reply, and skips a bad block with a warning instead of failing the rollup. See ADR 0010.
- **Exact names in `bench` on your own atlas.** A name from a logged event that appears in no other note of its scope (a file, a path, an identifier, an acronym) becomes a probe that must find its session, up to 200 of them beside the event and summary probes. On the author's atlas, 96% of 200 names are in the top five.
- **Open and Changed this week in the brief.** Open lists open items from topics and todos from the last 14 days that no rollup has read yet. On the benchmark, the share of recent todos the brief shows goes from 0% to 100% on the fixture and on the author's atlas, for about 20 to 40 more tokens.

### Changed

- **Renamed to Varve** (ADR 0009): the CLI, MCP server name, environment variables (`VARVE_DIR`, `VARVE_MODELS`), default folder (`~/Varve`), model cache and repository (`pomess/varve`). The `temporal-atlas` command, `TEMPORAL_ATLAS_*` variables, an existing `~/TemporalAtlas` folder and a model in the old cache keep working. `setup` replaces an MCP registration and a nightly job under the old name. The on-disk format is unchanged.

### Upgrading from 0.4

```sh
npm install -g github:pomess/varve
varve setup      # registers the server as varve and rewrites the hooks; your notes stay where they are
```

## 0.4.0

Open source, at `pomess/temporal-atlas`. Codex sessions are recorded like Claude Code ones, search matches by meaning, and a benchmark measures how well the atlas brings back past work.

### Added

- **Codex capture.** `setup` (when `~/.codex` exists) and `install codex` add the capture hooks to `~/.codex/hooks.json` and register the server with `codex mcp add`. Codex rollouts are read into the same activity record. `codex exec` runs and subagents count as headless. Codex does not pass a conversation id to MCP servers, so the server joins the Codex conversation that started in the same folder within five minutes. Run `/hooks` in Codex once to trust the new hooks.
- **Search by meaning.** `temporal-atlas models pull` (or `setup`) downloads potion-base-8M (about 30 MB, MIT) from a pinned Hugging Face revision and checks its hashes. Search then fuses keyword (BM25) and meaning matches, and each result says how it matched. The encoder is plain TypeScript: no native code, nothing sent anywhere. Without the model, search is keyword only, as before. `semanticSearch: false` in `atlas.config.json` turns it off.
- **Benchmark.** `temporal-atlas bench` scores search and the brief with no model call, with 95% bootstrap intervals and a paired comparison of hybrid against keyword search. `--fixture` runs a bundled atlas (26 sessions, 69 questions in a dev and a held-out split) that gives the same scores everywhere. On your own atlas it only reads, and its report holds numbers only. `--sweep` scores similarity thresholds, and `--paraphrase` has a model reword the queries (paid, asks first, `--max-usd`). See [BENCHMARK.md](BENCHMARK.md).
- `doctor` shows the Codex hooks and whether search by meaning is on.

### Changed

- Search leaves out day, week, month and year drafts that no person edited. They repeat their sessions' text and ranked above the session with the detail. Sealed summaries and edited drafts are still searched. On the fixture this alone raised keyword MRR from 0.47 to 0.55 (all 69 questions); with search by meaning the default reaches 0.64.
- Search breaks score ties by note name, so the same files always give the same order.

### Upgrading from 0.3

```sh
npm install -g github:pomess/temporal-atlas
temporal-atlas models pull       # search by meaning
temporal-atlas install codex     # only if you use Codex; then run /hooks in Codex
```

## 0.3.1

### Fixed

- Windows. Running the test suite on Windows found that the atlas assumed `/` in paths: every scope was read as a whole note path, and folder checks (`capture.ignorePaths`, `capture.generalPaths`, saved folder rules, file names in activity) never matched. `setup` could not find `claude.exe` or `claude.cmd`, and `tidy` could not start a `claude.cmd` shim; both now go through `cross-spawn`. CI runs on macOS, Linux and Windows.

## 0.3.0

Ready to share with colleagues: installs from a private GitHub repository (0.4.0 moved to the public `pomess/temporal-atlas`), and the nightly run works on laptops that are shut down overnight.

### Changed

- **Install from GitHub.** `npm install -g github:pomess/temporal-atlas` works without a build step: `dist/` is committed, and the compile script is no longer called `build`, which made npm prepare the clone and break global installs. The package is private and is never fetched from npm; `npx temporal-atlas` is gone from the code and docs (ADR 0005).
- **The nightly run catches up.** launchd only runs a missed calendar job after sleep, not after the computer was off, so a laptop shut down overnight never ran it. The job now also runs at login and every hour, and `tidy --scheduled` writes rollups at most once per atlas day. A run that never reached the model is tried again the next hour.
- **Hooks work on Windows.** They pass the atlas folder as `--dir` instead of a `TEMPORAL_ATLAS_DIR=` prefix, which cmd and PowerShell cannot read, and use forward slashes there. Every command accepts `--dir`.
- `doctor` warns when the nightly schedule has never run or has not run for 36 hours, and shows when it last ran.

### Added

- `tidy --scheduled`, used by the schedule; `.atlas/nightly.json` records when the schedule was installed and last ran.
- On Windows, `install nightly` prints a Task Scheduler command.
- CI runs on Windows, and checks that `dist/` matches the source.

### Fixed

- Activity capture recorded `npm publish --dry-run` as a publish.

### Upgrading from 0.2

```sh
npm install -g github:pomess/temporal-atlas
temporal-atlas install claude-code   # hooks in the new format
temporal-atlas install nightly       # only if you use the nightly run
```

## 0.2.0

Fixes found by running v0.1 for 12 days across 20 projects, where no rollup was ever sealed.

### Added

- **Activity capture.** A `Stop` hook reads what the transcript gained after each turn and writes an `### Activity` section into the session note: the session title, requests, files changed, commits, pushes and PRs, and the last reply. No model is involved, and every session now has a record even if the agent never called `log` or `close_session`.
- **`temporal-atlas tidy`.** Writes pending rollups with `claude -p`, one call per rollup, inside a token and dollar budget, and logs each one to `.atlas/tidy.log`. `--dry-run` shows the plan and estimate.
- **`temporal-atlas install nightly`.** Schedules `tidy --yes` with launchd on macOS (or prints a crontab line) and sets `"rollups": "nightly"`, so agents leave rollups to the nightly run.
- **`temporal-atlas backfill`.** Records sessions from before activity capture using their transcripts, folds the notes of a reopened conversation into one, skips headless runs, and merges scopes that only ran in app scratch folders into `general`. No model.
- **`temporal-atlas setup` and `uninstall`.** One command creates the atlas, registers the MCP server with Claude Code, installs the hooks and, if wanted, the nightly run; another removes all of it and keeps the notes.
- **Client isolation by default.** `isolateNewScopes` (on when you say yes in `setup`) starts every new project isolated.
- **Moving a session.** `log` with a `scope` moves the session to that project, for client work done in another project's folder. The capture hooks follow the move.
- Installing from git (`npm install -g github:...`) builds the package.
- Config: `rollups`, `isolateNewScopes`, `capture.headless`, `capture.ignorePaths`, `capture.generalPaths`, and a `tidy` block.

### Changed

- A day no longer waits for orphan sessions. It seals from what it has and becomes stale if an orphan summary arrives later. Days that only have orphans are not counted as worked, so they cannot hold up a week.
- Hooks no longer create orphan notes; a conversation that is reopened or resumed keeps writing to the same note.
- Headless sessions (`claude -p` and similar) are not recorded unless `capture.headless` is on.
- Sessions in Claude Desktop scratch folders go to `general` instead of a scope per folder.
- `doctor` warns about a backlog over the cost gate, sessions that can be backfilled, and hooks from an older version, and says "No problems found" only when there are none.
- The brief no longer lists scopes with an empty headline, and builds in under 100 ms on a 200-note atlas (it was about 2 s, reading orphan transcripts).

### Upgrading from 0.1

```sh
temporal-atlas install claude-code   # adds the Stop hook
temporal-atlas backfill --dry-run    # see what it would change, then run without --dry-run
temporal-atlas tidy --dry-run        # see the backlog and its estimate
```

## 0.1.0

First version: MCP server with eleven tools, Claude Code session hooks, CLI.
