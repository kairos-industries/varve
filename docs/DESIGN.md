# Temporal Atlas design (v1)

Status: accepted; 0.4 implements it. 0.2 added activity capture, the tidy command and backfill (section 18); 0.4 added Codex capture (section 10), search by meaning (section 19) and the benchmark (section 20). Terms in this document are defined in [CONTEXT.md](CONTEXT.md).

## What it is

Temporal Atlas is an MCP server that gives any agent (Claude Code, Codex, Cursor, Windsurf, VS Code Copilot) a memory of past work. It records sessions as they happen and summarizes them into day, week, month and year notes, each layer shorter than the one below. At the start of a session the agent receives a brief of recent work in its scope and can zoom into any period or search the whole atlas.

The atlas is a folder of plain Markdown with YAML frontmatter and `[[wikilinks]]`. It opens directly in Obsidian, works in git, and needs no database.

The server never calls a model. The connected agent writes summaries ([ADR 0001](adr/0001-the-agent-writes-every-summary.md)), or the `tidy` command does when the user runs or schedules it ([ADR 0004](adr/0004-tidy-may-call-a-model-when-the-user-schedules-it.md)).

## 1. Folder layout

The atlas root is `$TEMPORAL_ATLAS_DIR`, defaulting to `~/TemporalAtlas`.

```
<atlas>/
  atlas.config.json
  scopes/
    <scope>/
      sessions/2026/10/2026-10-08T1432-k3f9q2.md
      days/2026/2026-10-08.md
      weeks/2026/2026-W41.md
      months/2026/2026-10.md
      years/2026.md
      topics/<Topic name>.md
  index/
    days/2026/2026-10-08.md
    weeks/2026/2026-W41.md
    months/2026/2026-10.md
    years/2026.md
  .atlas/                      hidden from Obsidian
    scopes.json                path and git-remote rules that map to scopes
    sessions.json              open sessions and their client session ids
    locks/                     one lock file per rollup in progress
    capture/                   how far each conversation's transcript has been read, and its note
    mutex/                     short-lived note locks shared by the hooks and the server
    tidy.log                   one JSON line per rollup a tidy run wrote, with tokens and cost
```

Week files use the ISO week-numbering year, so 2025-12-29 belongs to `2026-W01`.

The Markdown files are the source of truth ([ADR 0002](adr/0002-markdown-files-are-the-source-of-truth.md)). The search index lives in memory and is rebuilt from the files when the server starts.

### Frontmatter

Every note the server writes carries:

```yaml
atlas: period          # session | period | index | topic
layer: day             # session | day | week | month | year (absent on topics)
period: 2026-10-08
scope: temporal-atlas
status: sealed         # open | closed (sessions); draft | sealed | stale (periods)
headline: "Designed the time model and tool list for Temporal Atlas"
sources: ["[[2026-10-08T1432-k3f9q2]]", "[[2026-10-08T1910-p0x2aa]]"]
sealed_at: 2026-10-09T09:12:00+02:00
atlas_hash: 9c1e...    # hash of the body as the server last wrote it
```

`headline` is one line, required on every sealed note, and is what index notes and the brief show for that period.

## 2. Time model

### Layers and periods

| Layer | Period id | Closes at | Built from | Length target |
|---|---|---|---|---|
| Session segment | session id + date | session close or day boundary | events and the agent's summary | ~1,500 tokens per segment, plus events |
| Day | `2026-10-08` | next day 04:00 | that day's session segments | ~600 |
| Week | `2026-W41` | Monday 04:00 | that week's sealed day notes | ~500 |
| Month | `2026-10` | 1st of next month 04:00 | that month's sealed day notes | ~400 |
| Year | `2026` | 1 Jan 04:00 | that year's sealed month notes | ~800 |

Weeks and months are both built from day notes because ISO weeks cross month boundaries, so a month cannot be assembled from whole weeks ([ADR 0003](adr/0003-weeks-and-months-both-roll-up-from-days.md)). A month of about 20 worked days is roughly 12k tokens of input, which fits under the default cost gate.

The server rejects a `seal` whose content exceeds 150% of the length target and returns the target in the error.

### Calendar rules

- All times use the system's local time zone unless `atlas.config.json` sets one.
- The day boundary is 04:00 local by default. Work at 01:30 on Thursday counts toward Wednesday.
- Weeks start on Monday and use ISO week numbers.
- A session is split into segments at each day boundary it crosses. Events logged after 04:00 go into the new day's segment of the same session note.

### Draft and sealed notes

An open period's note is a draft. The server assembles it without a model by listing the headlines and summaries of its children (sessions for a day, day notes and today's draft for a week, and so on). Drafts are written to disk so they show in Obsidian. The server regenerates them when a session closes or a period is sealed, and `brief` and `zoom` build drafts fresh on every call.

If a human edits a draft (its body no longer matches `atlas_hash`), the server stops regenerating it and passes the edited text to the rollup as an extra source.

When a period closes, it becomes a pending rollup. Once the agent writes its summary through `seal`, the note is sealed.

### When layers appear

The brief shows a layer only when it adds something not already shown. A layer's current draft appears only if it contains at least one sealed child that the brief does not show elsewhere. The year layer therefore first appears after the first month has been sealed.

## 3. Scopes

### Detection

When a session starts, the server picks its scope in this order:

1. A rule in `.atlas/scopes.json` matching the git remote or the working directory.
2. The repository name from the `origin` git remote, as a slug.
3. The git root folder name.
4. The working directory name, unless it is the home directory.
5. `general`.

An agent can set the scope on its first `log` call when the client gives no working directory (Claude Desktop, chat apps). Each session note records its origin (git remote or folder).

A session moves to another scope when the agent passes `scope` to `log` after the note exists, for work done in one project's folder that belongs to another client. The note moves, the hooks follow it, and sealed days in the old scope become stale. With `isolateNewScopes`, the first note of a new scope marks it isolated.

The `scopes` tool can mark a scope isolated, map the current folder to a scope for future sessions (`mapHere`), and merge one scope into another (`mergeInto`). Merging into a name that has no notes yet is a rename. A merge moves the sessions, adds rules for their origins to `scopes.json`, and marks overlapping sealed notes in the target stale.

### Visibility

| From a session in | Can read |
|---|---|
| An isolated scope X | X and `general` |
| A non-isolated scope Y | Y, `general`, other non-isolated scopes, index notes |
| `general` | `general`, all non-isolated scopes, index notes |

An isolated scope never appears in index notes, search results, or briefs outside itself. The rule is strict: an agent outside an isolated scope cannot read it even by asking for it by name. To read it, open a session inside that scope or remove its isolation with `scopes`.

### Index notes

Index notes are assembled without a model. Each one lists, for its period, the `headline` of every non-isolated scope that has a note for that period, with a link to that note.

## 4. Recording sessions

### Lifecycle

1. **Start.** On connect, the server registers the session in `.atlas/sessions.json` but writes no file. If the Claude Code adapter is installed, the `SessionStart` hook has already recorded the client session id, working directory and transcript path, and the server links to that record.
2. **First write.** The first `log` or `close_session` call, or the first turn the `Stop` hook captures, creates the session note.
3. **During the session.** `log(type, text, topics?)` appends a timestamped event to the current segment.
4. **Day change.** On the first tool call after a day boundary, the server opens a new segment and attaches a checkpoint notice to the tool result. The notice asks the agent to summarize the finished segment with `close_session(headline, summary, segment)` and lists any pending rollups.
5. **Close.** `close_session(headline, summary)` writes the summary for the current segment and marks the session closed. Headings in the summary are demoted below the note's own sections. A client disconnect, or the `SessionEnd` hook, also closes it.

A session note has one `## <date>` section per segment, each with a summary (goal, what was done, decisions and why, files and artifacts touched, open threads, topic links) and its events.

### Activity capture

With the Claude Code or Codex hooks installed, the `Stop` hook runs after every turn. It reads only the bytes the transcript gained since the last turn (the offset is kept in `.atlas/capture/`) and rewrites the session's `### Activity` section for each day it touched:

- the session title Claude Code generated, as the first line,
- the first three and last five requests a person typed, with times (tool results, injected context and system notices are dropped; slash commands are kept),
- the files changed through Edit, Write, MultiEdit and NotebookEdit,
- commits, pushes, PRs opened or merged, and npm publishes, from shell commands,
- the last reply of the day, and the number of requests and tool calls.

No model is involved. The first turn creates the session note, so a session the agent never logged still has a record, and a day can be summarized from activity alone. The MCP server and the hooks write the same note under a shared lock, so events, summaries and activity sit side by side.

Codex rollouts (`~/.codex/sessions/.../rollout-*.jsonl`) are read into the same record. Finished items arrive as `item_completed` events: `UserMessage` for requests (the attachment list the desktop app puts first is dropped), `AgentMessage` for replies, `CommandExecution` for shell commands (milestones, and files named in `apply_patch` bodies), and `FileChange` for edits. A session whose `session_meta` says it came from `codex exec`, the SDK or a subagent is headless.

A conversation that is reopened or resumed keeps the same Claude Code session id and transcript, and keeps writing to the same note. If more activity lands on a day that is already sealed, the day becomes stale.

The hooks skip sessions in `capture.ignorePaths`, headless sessions (every prompt marked `turnOrigin: sdk` in the transcript) unless `capture.headless` is on, and the `claude -p` runs started by `tidy` (`TEMPORAL_ATLAS_CHILD=1`).

### Transcripts

The server stores the transcript path in frontmatter. Activity holds short excerpts of requests and replies, never tool output. Full conversation text reaches a model only when an orphan session is summarized (section 5).

### Secret scrubbing

Before writing any note, the server replaces likely secrets with `[redacted:<kind>]`. The default patterns cover Anthropic, OpenAI, GitHub, Slack and AWS keys, bearer tokens, private key blocks, and credentials inside connection strings. `atlas.config.json` can add patterns.

## 5. Rollups

### Pending rollups

A pending rollup is one of:

- a closed period with no sealed note,
- a sealed note marked stale,
- an orphan session (summarized from its transcript, with tool output removed).

No day waits for an orphan session. A day seals from the sessions that have content, and becomes stale if an orphan summary for that day arrives later. Days with only orphan sessions are not worked days, so they never hold up a week or month.

Rollups run per scope: `pending()` covers the session's own scope and `pending(all: true)` every scope the session can see.

The server works through pending rollups from the oldest period first and from the lowest layer up. A day is sealed before its week and month, and a month before its year.

### Checkpoints

The server runs the same pending check at four points:

1. **Session start.** The server instructions list pending rollups and their estimated cost.
2. **Day change during a session.** Attached to the first tool result after the day boundary.
3. **Session close.** Returned by `close_session`.
4. **Tidy.** When the user asks, the agent calls `pending()`.

A period can be summarized only once. `summarize(period)` takes a lock in `.atlas/locks/`, so a second agent asking for the same period gets `in_progress`. Locks expire after 30 minutes.

### Cost gate

The server estimates each rollup's input tokens as source characters divided by 4. `pending()` walks the list in order and marks each item `auto` while the running total stays under the gate (default 30,000 tokens). Every item after that is marked `needs_confirmation`.

`summarize` refuses a `needs_confirmation` item unless it is called with `confirmed: true`. The server instructions tell the agent to get that confirmation from the user and to tell the user the estimate, for example "3 weeks of backlog: 12 rollups, about 85k tokens."

### Tidy

`temporal-atlas tidy` writes pending rollups without an agent session. It works through the same pending list in the same order, one `claude -p` call per rollup:

```
claude -p --model <tidy.model> --output-format json --no-session-persistence \
  --strict-mcp-config --setting-sources project --tools "" \
  --max-budget-usd <what is left of the run's budget> --system-prompt <...>
```

The child has no tools, no MCP servers, no user hooks and saves no transcript. The prompt is the `summarize` instructions and sources, asking for a reply that starts with a `Headline:` line. Tidy seals the reply; if the note is over the hard limit it asks once to shorten it, then gives up on that rollup until the next run.

A run stops before a rollup whose input estimate plus length target would pass `tidy.maxTokens`, and once `tidy.maxUsd` is spent as `claude` reports it. Orphan sessions are left out unless `--orphans` is passed. Each rollup is appended to `.atlas/tidy.log` with its tokens and cost.

`temporal-atlas install nightly` schedules `tidy --scheduled` at `tidy.at` (04:30 by default) with launchd on macOS, and prints a crontab line on Linux and a Task Scheduler command on Windows. The job also runs at login and every hour, because launchd does not run a calendar job that was missed while the computer was off (it only catches up after sleep), and laptops are often off at 04:30. `--scheduled` makes the extra runs cheap: it writes rollups at most once per atlas day, recorded in `.atlas/nightly.json`. A run that never reached the model (offline, signed out) is not recorded, so the next hour tries again. `doctor` warns when the schedule has never run or has not run for 36 hours. It sets `"rollups": "nightly"`: the server instructions, the brief and `close_session` then tell the agent the nightly run does rollups, and the day-change checkpoint stops listing them.

### Sealing

`seal(period, content, headline, topic_updates?)` writes the sealed note, records `sources` and `atlas_hash`, regenerates the parent draft and the index note, and applies topic updates. If the sealed note was a re-rollup of a stale note, the old version is kept under `## Previous version` in the same file.

## 6. Reading

### Brief in the server instructions

When a client connects, the server builds the brief for the detected scope and returns it inside the MCP `instructions`. Claude Code, Cursor and Windsurf put these instructions into the model's context. This version is capped at about 1,500 tokens:

- the scope name, and whether it is isolated,
- the last closed session's headline and open threads,
- the headlines of today's sessions,
- the last worked day's headline and key points,
- this week's day headlines,
- the pending rollups line,
- how to use the tools.

### `brief` tool

`brief(scope?, lookback?)` returns the full brief, about 4,000 to 5,000 tokens. It is the fallback for clients that only use tools (VS Code Copilot) and the way to see further back.

| Layer | Shown by default |
|---|---|
| Session | the last closed session in full |
| Day | today's draft and the last worked day |
| Week | this week's draft and last week |
| Month | this month's draft and last month |
| Year | the sealed months of the current year, once there is one |
| Index | this week's headlines from other visible scopes |

"Last worked day" is the most recent day with sessions in the scope, so a brief on Monday shows Friday. `lookback` sets how many closed periods each layer shows, default 1.

### `zoom` and `search`

`zoom(period, scope?)` returns a period note and the list of notes beneath it, so the agent can move from a year down to the sessions behind one day.

`search(query, scope?, layer?, from?, to?)` searches every note the current scope can see, by keyword and, when the search model is installed, by meaning (section 19). Drafts that no person edited are left out: they are assembled from the notes beneath them and would only repeat those notes' matches above them. Each result says whether it matched by keyword, by meaning or both. Ties go to the note name, so the same files always give the same order.

## 7. Topics

Topics live in `scopes/<scope>/topics/`. A topic note has:

```markdown
## What we know now
<current state, rewritten when it changes>

## Timeline
- 2026-10-08 Chose 04:00 as the day boundary. [[2026-10-08]]
```

`topic(name, update?)` reads a topic or creates or updates it. Before creating one, the server compares the name with existing topics in the scope (normalized names, word overlap and edit distance). If any are close, it returns them and creates the new topic only when called with `force: true`.

Rollups can propose topic changes in `seal` through `topic_updates`. Each update appends a timeline entry linking to the sealed period note and can replace "What we know now."

Topics in `general` are visible from every scope. Topics in an isolated scope follow that scope's visibility.

## 8. Edits and corrections

- **Human edits win.** If a note's body no longer matches its `atlas_hash`, the server treats the file as edited by a human. It never overwrites it, updates the stored hash, and treats the new text as correct from then on.
- **Agent corrections** go through `amend(note, change, reason)`, which appends a dated entry under `## Amendments`. The brief and rollups read amendments as part of the note.
- **Stale propagation.** When a sealed note changes through an edit or an amendment, every sealed note that lists it in `sources` is marked stale, and so on up the layers. Each stale note becomes a pending rollup, subject to the cost gate.

The server scans for edited notes at each checkpoint.

## 9. Tools

All tools are scoped to the session's scope unless they take a `scope` argument, and the visibility rules in section 3 always apply.

| Tool | Arguments | Returns |
|---|---|---|
| `brief` | `scope?`, `lookback?` | the layered brief |
| `log` | `type`, `text`, `topics?`, `scope?` (first call only) | the event as written |
| `close_session` | `headline`, `summary`, `segment?` | confirmation and pending rollups |
| `pending` | none | pending rollups with estimates, each `auto` or `needs_confirmation` |
| `summarize` | `period`, `scope?`, `confirmed?` | the source notes, the length target and writing instructions |
| `seal` | `period`, `content`, `headline`, `scope?`, `topic_updates?` | the sealed note's path and any newly unblocked rollups |
| `zoom` | `period`, `scope?` | the note and its children |
| `search` | `query`, `scope?`, `layer?`, `from?`, `to?` | ranked results |
| `topic` | `name`, `scope?`, `update?`, `force?` | the topic note, or similar existing topics |
| `scopes` | `set?` (`isolated`, `mapHere`, `mergeInto`) | the scope list with visibility and rules |
| `amend` | `note`, `change`, `reason` | the amended note and the notes now stale |

The server uses only tools, no MCP resources or prompts, so it behaves the same in every client.

## 10. Claude Code and Codex adapters

`temporal-atlas install claude-code` adds three hooks to `~/.claude/settings.json`. It prints the exact change and asks before writing.

- `SessionStart` runs `temporal-atlas hook session-start`, which records the session id, working directory and transcript path in `.atlas/sessions.json`, reusing the note of an earlier start of the same conversation.
- `Stop` runs `temporal-atlas hook stop` after every turn, which updates the session's activity (section 4).
- `SessionEnd` runs `temporal-atlas hook session-end`, which reads the last turn and closes the session.

Each hook runs `node "<path to dist/cli/main.js>" --dir "<atlas folder>" hook <event>`. The folder goes in `--dir` rather than a `TEMPORAL_ATLAS_DIR=` prefix, which cmd and PowerShell cannot read, and paths use forward slashes on Windows.

A hook never fails the agent: errors go to stderr and the hook exits 0.

`temporal-atlas install codex` (and `setup`, when `~/.codex` exists) adds the same three hooks to `~/.codex/hooks.json`, each with `--client codex`. Codex sends the same payload fields (`session_id`, `cwd`, `transcript_path`). Its `SessionEnd` hooks may run for 3 seconds at most, so that one has a 3-second timeout. Codex runs a new hook only after the user trusts it with `/hooks`.

Codex starts its MCP servers without telling them which conversation they serve. When an MCP session has no client session id, it joins the Codex hook session that started in the same folder within five minutes and that no other MCP session has joined (`joined` in the registry). From then on it writes to that session's note, so events and activity sit together. Two Codex conversations started at the same time in one folder can be paired the wrong way round.

## 11. CLI

| Command | Does |
|---|---|
| `temporal-atlas` | runs the MCP server over stdio |
| `temporal-atlas init [dir]` | creates the atlas folder and config |
| `temporal-atlas install claude-code` | installs the hooks (asks first) |
| `temporal-atlas install nightly` | schedules `tidy --scheduled`, catching up after the computer was off (asks first; `--at`, `--remove`) |
| `temporal-atlas tidy` | writes pending rollups with `claude -p` within a budget (`--dry-run`, `--yes`, `--scope`, `--model`, `--max-tokens`, `--max-usd`, `--orphans`) |
| `temporal-atlas backfill` | records older sessions from their transcripts, without a model (`--dry-run`, `--prune`) |
| `temporal-atlas doctor` | checks the atlas: backlog, unrecorded sessions, hook version, broken links, stale notes, frontmatter errors |
| `temporal-atlas hook <event>` | internal, called by the hooks: `session-start`, `stop`, `session-end` |

## 12. Configuration

`atlas.config.json` at the atlas root:

```json
{
  "timezone": "local",
  "dayBoundary": "04:00",
  "costGateTokens": 30000,
  "lengthTargets": { "segment": 1500, "day": 600, "week": 500, "month": 400, "year": 800 },
  "briefTokens": { "instructions": 1500, "tool": 5000 },
  "scrubPatterns": [],
  "rollups": "agent",
  "capture": {
    "headless": false,
    "ignorePaths": [],
    "generalPaths": ["~/Library/Application Support/Claude", "~/.config/Claude", "~/AppData/Roaming/Claude"]
  },
  "tidy": { "command": "claude", "model": "sonnet", "maxTokens": 200000, "maxUsd": 2, "at": "04:30" }
}
```

`TEMPORAL_ATLAS_DIR` sets the atlas location. Scope detection checks `capture.generalPaths` after the saved rules: a session in one of those folders goes to `general`.

## 13. Implementation

TypeScript on Node 20 or later. It is installed from the GitHub repository (`npm install -g github:pomess/temporal-atlas`), not from npm: the package is marked private, and the compiled `dist/` is committed so installing needs no build step. CI checks that `dist/` matches the source.

Dependencies: `@modelcontextprotocol/sdk`, `zod`, `yaml`, `minisearch`. Tests use `vitest`.

```
src/
  time/       clock, day boundary, period ids, ISO weeks
  store/      read and write notes, frontmatter, hashes, locks
  scopes/     detection, rules, visibility
  sessions/   lifecycle, segments, events
  capture/    activity from Claude Code and Codex transcripts, read incrementally
  embed/      the search model: WordPiece tokenizer, static embeddings, download
  bench/      the benchmark and its fixture atlas
  tidy/       rollups through claude -p, budgets, tidy.log
  rollup/     pending list, cost gate, sources, seal, stale propagation
  brief/      brief assembly and token caps
  search/     keyword index, embeddings per note, rank fusion
  topics/     topic notes and duplicate check
  scrub/      secret patterns
  server/     MCP tool registration
  cli/        init, install, doctor, hook
```

The clock is injected everywhere so tests can move time.

## 14. Testing

- **Unit tests** with a fake clock: the 04:00 boundary, ISO weeks at year ends, month and year changes, sessions spanning midnight and spanning several days, rollup order, cost gate arithmetic, visibility rules, stale propagation, human-edit detection, secret scrubbing.
- **Integration tests** start the real server and drive it through the MCP SDK client, using fixed text in place of agent-written summaries. No test calls a model.
- **One manual end-to-end check** in a real Claude Code session before release, run only with the user's go-ahead.

## 15. Scope of v1

In v1: the stdio MCP server, the Claude Code adapter, and the CLI. 0.4 added the Codex adapter, search by meaning and the benchmark.

Later:
- Open todos from earlier sessions in the brief (the benchmark scores this at 0% today).
- A shared HTTP server so parallel sessions share one process.
- An optional mode where the server calls a model itself, for users who want rollups without an agent.

## 16. Verified in use

Confirmed by 12 days of daily use in Claude Code (CLI and VS Code), October 2026:

- The MCP server gets `CLAUDE_CODE_SESSION_ID` and links to the hook's record: sessions carry both the agent's events and the hook's transcript path.
- Claude Code starts stdio MCP servers in the project directory; scopes came from git remotes as designed.
- The `SessionEnd` payload carries `session_id`, `cwd` and `transcript_path`.
- Reopening a VS Code conversation fires `SessionStart` and `SessionEnd` again with the same session id and transcript. v0.1 wrote a new note each time; v0.2 keeps one note per conversation.
- `claude -p` runs fire the same hooks; their prompts are marked `turnOrigin: sdk`, interactive ones `turnOrigin: human`.

Confirmed against 288 Codex rollouts (codex-cli 0.166, October 2026): the rollout format in section 4, and that `codex exec` and subagent runs make up most of them (284), all skipped as headless.

Still open: whether other clients truncate long server `instructions`; whether Codex passes a conversation id to MCP servers in a later version, which would replace the five-minute join.

## 17. Publishing

MIT license. The repository is public at `pomess/temporal-atlas`, and anyone installs from it with `npm install -g github:pomess/temporal-atlas`. The package is not published to npm (ADRs 0005 and 0008). The search model is downloaded separately under its own MIT licence and is not in the repository.

## 18. What v0.2 changed, and why

v0.1 ran for 12 days across 20 scopes. 189 sessions were recorded and no period was ever sealed. The causes:

| Measured in v0.1 | Cause | v0.2 |
|---|---|---|
| 147 of 189 sessions (78%) were orphans | Agents often finish without `close_session` | Activity capture records every session from its transcript, without a model |
| Every day waited on its orphans, so no week or month could start | Days were blocked until each orphan was summarized | Days no longer wait for orphans |
| 78 orphans were 5-second `claude -p` runs of another tool, each holding a copy of a whole transcript: half the backlog | Headless runs fire the same hooks | Headless sessions are skipped |
| 9 scopes named `scratch-2026-10-…` | Claude Desktop runs each chat in its own scratch folder | `capture.generalPaths` sends them to `general` |
| One VS Code conversation became 10 notes | Each reopen fired `SessionStart` again | One note per conversation |
| About 2.36M tokens pending | All of the above | About 64k tokens, none blocked, after `backfill` |
| Brief took about 2 s | Each brief re-read orphan transcripts | Under 100 ms |
| `doctor` said "No problems found" | It reported counts, not problems | Warnings for the backlog, unrecorded sessions and old hooks |

Rollups still need someone to write them. `tidy` and `install nightly` make that a scheduled job with a budget instead of a request the agent has to remember.

## 19. Search by meaning

The search model is [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M) (model2vec, MIT): a BERT WordPiece vocabulary of 29,528 tokens and one 256-dimensional vector per token. A text's embedding is the mean of its tokens' vectors (unknown tokens dropped, at most 512 tokens), scaled to unit length. That needs no neural network at query time, so it runs in plain TypeScript with no native code (ADR 0006). The tokenizer and the vectors match the reference `model2vec` library to float precision.

`temporal-atlas models pull` downloads `tokenizer.json` and `model.safetensors` (about 30 MB) from a pinned revision into `~/.cache/temporal-atlas/models` (`TEMPORAL_ATLAS_MODELS` to change it), and checks their SHA-256 hashes before saving. `setup` offers it. The server never downloads anything: without the model, search is keyword only, as before.

A note is embedded in pieces: paragraphs and list items, merged up to about 60 words, because one vector for a whole note says little. A note's similarity to a query is that of its best piece. Pieces at or above the similarity threshold (0.35) are ranked, the top 50 are kept, and that list is fused with the BM25 list by reciprocal rank (k = 60). Embeddings are kept in memory for the life of the process and redone when a file changes. The first search in a session embeds every note (about 60 ms for 250 notes); later ones cost about the same as keyword search.

## 20. Benchmark

`temporal-atlas bench` ([BENCHMARK.md](../BENCHMARK.md)) scores search (hit@1, hit@5, MRR, in keyword, meaning and both modes) and the brief (tokens, build time, share of recent todos shown). It calls no model and only reads the atlas; its report holds numbers only (ADR 0007).

- `--fixture` builds `src/bench/fixture.ts` (26 invented sessions, 69 questions: 33 dev, seen while choosing the defaults, and 36 held out) in a temporary folder with fixed session ids, so the scores are the same everywhere.
- Every score has a 95% bootstrap interval (fixed seed), and hybrid is compared with keyword search probe by probe.
- Without it, probes come from the user's atlas: logged decisions, findings and changes (known-item search, each in its own scope), and sealed day and week headlines (to find their sources).
- `--sweep` scores hybrid search at thresholds 0.20 to 0.45, so the default can be chosen from real atlases.
- `--paraphrase` has a model reword the probe queries, through the user's `claude` CLI, after asking, within `--max-usd`.
