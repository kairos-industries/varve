# Temporal Atlas design (v1)

Status: proposed, awaiting confirmation. Terms in this document are defined in [CONTEXT.md](CONTEXT.md).

## What it is

Temporal Atlas is an MCP server that gives any agent (Claude Code, Codex, Cursor, Windsurf, VS Code Copilot) a memory of past work. It records sessions as they happen and summarizes them into day, week, month and year notes, each layer shorter than the one below. At the start of a session the agent receives a brief of recent work in its scope and can zoom into any period or search the whole atlas.

The atlas is a folder of plain Markdown with YAML frontmatter and `[[wikilinks]]`. It opens directly in Obsidian, works in git, and needs no database.

The server never calls a model. The connected agent writes every summary ([ADR 0001](docs/adr/0001-the-agent-writes-every-summary.md)).

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
```

Week files use the ISO week-numbering year, so 2026-12-29 belongs to `2027-W01`.

The Markdown files are the source of truth ([ADR 0002](docs/adr/0002-markdown-files-are-the-source-of-truth.md)). The search index lives in memory and is rebuilt from the files when the server starts.

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

Weeks and months are both built from day notes because ISO weeks cross month boundaries, so a month cannot be assembled from whole weeks ([ADR 0003](docs/adr/0003-weeks-and-months-both-roll-up-from-days.md)). A month of about 20 worked days is roughly 12k tokens of input, which fits under the default cost gate.

The server rejects a `seal` whose content exceeds 150% of the length target and returns the target in the error.

### Calendar rules

- All times use the system's local time zone unless `atlas.config.json` sets one.
- The day boundary is 04:00 local by default. Work at 01:30 on Thursday counts toward Wednesday.
- Weeks start on Monday and use ISO week numbers.
- A session is split into segments at each day boundary it crosses. Events logged after 04:00 go into the new day's segment of the same session note.

### Draft and sealed notes

An open period's note is a draft. The server assembles it without a model by listing the headlines and summaries of its children (sessions for a day, day notes and today's draft for a week, and so on). Drafts are written to disk so they show in Obsidian, and the server regenerates them whenever a source changes.

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

An agent can set the scope on its first `log` call when the client gives no working directory (Claude Desktop, chat apps). The `scopes` tool can rename scopes, mark them isolated, and merge them. A merge adds a rule to `scopes.json` so several repositories can share one scope.

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
2. **First write.** The first `log` or `close_session` call creates the session note.
3. **During the session.** `log(type, text, topics?)` appends a timestamped event to the current segment.
4. **Day change.** On the first tool call after a day boundary, the server opens a new segment and attaches a checkpoint notice to the tool result. The notice asks the agent to summarize the finished segment with `close_session(summary, segment)` and lists any pending rollups.
5. **Close.** `close_session(summary)` writes the summary for the current segment and marks the session closed. A client disconnect, or the `SessionEnd` hook, also closes it.

A session note has one `## <date>` section per segment, each with a summary (goal, what was done, decisions and why, files and artifacts touched, open threads, topic links) and its events.

### Transcripts

The server stores the transcript path in frontmatter and never copies transcript content into the atlas, except when summarizing an orphan session (section 5).

### Secret scrubbing

Before writing any note, the server replaces likely secrets with `[redacted:<kind>]`. The default patterns cover Anthropic, OpenAI, GitHub, Slack and AWS keys, bearer tokens, private key blocks, and credentials inside connection strings. `atlas.config.json` can add patterns.

## 5. Rollups

### Pending rollups

A pending rollup is one of:

- a closed period with no sealed note,
- a sealed note marked stale,
- an orphan session (summarized from its transcript, with tool output removed).

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
| Year | the current year, once it has a sealed month |
| Index | this week's headlines from other visible scopes |

"Last worked day" is the most recent day with sessions in the scope, so a brief on Monday shows Friday. `lookback` sets how many closed periods each layer shows, default 1.

### `zoom` and `search`

`zoom(period, scope?)` returns a period note and the list of notes beneath it, so the agent can move from a year down to the sessions behind one day.

`search(query, scope?, layer?, from?, to?)` runs a keyword search (MiniSearch, BM25) across every note the current scope can see, with results ranked and grouped by layer.

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
| `close_session` | `summary`, `segment?` | confirmation and pending rollups |
| `pending` | none | pending rollups with estimates, each `auto` or `needs_confirmation` |
| `summarize` | `period`, `scope?`, `confirmed?` | the source notes, the length target and writing instructions |
| `seal` | `period`, `content`, `headline`, `scope?`, `topic_updates?` | the sealed note's path and any newly unblocked rollups |
| `zoom` | `period`, `scope?` | the note and its children |
| `search` | `query`, `scope?`, `layer?`, `from?`, `to?` | ranked results |
| `topic` | `name`, `scope?`, `update?`, `force?` | the topic note, or similar existing topics |
| `scopes` | `set?` (rename, isolate, merge) | the scope list with visibility |
| `amend` | `note`, `change`, `reason` | the amended note and the notes now stale |

The server uses only tools, no MCP resources or prompts, so it behaves the same in every client.

## 10. Claude Code adapter

`npx temporal-atlas install claude-code` adds two hooks to `~/.claude/settings.json`. It prints the exact change and asks before writing.

- `SessionStart` runs `temporal-atlas hook session-start`, which records the session id, working directory and transcript path in `.atlas/sessions.json`.
- `SessionEnd` runs `temporal-atlas hook session-end`, which closes the session. If the session has no events and no summary, it becomes an orphan session.

There are no per-turn hooks.

## 11. CLI

| Command | Does |
|---|---|
| `temporal-atlas` | runs the MCP server over stdio |
| `temporal-atlas init [dir]` | creates the atlas folder and config |
| `temporal-atlas install claude-code` | installs the hooks (asks first) |
| `temporal-atlas doctor` | checks the atlas: broken links, stale notes, orphan sessions, frontmatter errors |
| `temporal-atlas hook <event>` | internal, called by the hooks |

## 12. Configuration

`atlas.config.json` at the atlas root:

```json
{
  "timezone": "local",
  "dayBoundary": "04:00",
  "costGateTokens": 30000,
  "lengthTargets": { "segment": 1500, "day": 600, "week": 500, "month": 400, "year": 800 },
  "briefTokens": { "instructions": 1500, "tool": 5000 },
  "scrubPatterns": []
}
```

`TEMPORAL_ATLAS_DIR` sets the atlas location.

## 13. Implementation

TypeScript on Node 20 or later, published to npm as `temporal-atlas` and run with `npx temporal-atlas`.

Dependencies: `@modelcontextprotocol/sdk`, `zod`, `yaml`, `minisearch`. Tests use `vitest`.

```
src/
  time/       clock, day boundary, period ids, ISO weeks
  store/      read and write notes, frontmatter, hashes, locks
  scopes/     detection, rules, visibility
  sessions/   lifecycle, segments, events
  rollup/     pending list, cost gate, sources, seal, stale propagation
  brief/      brief assembly and token caps
  search/     index build and query
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

In v1: the stdio MCP server, the Claude Code adapter, and the CLI.

Later:
- Codex adapter (transcript import). Codex can already use every tool in v1; it only lacks automatic capture.
- Optional semantic search.
- A shared HTTP server so parallel sessions share one process.
- An optional mode where the server calls a model itself, for users who want rollups without an agent.

## 16. To verify during the build

- How the MCP server process links to the Claude Code session id. Options: an environment variable passed to MCP servers, a shared parent process, or matching on working directory and start time.
- Whether Claude Code starts stdio MCP servers in the project directory (scope detection depends on it).
- Whether Claude Code or other clients truncate long server `instructions`.
- The `SessionEnd` hook payload.
- Codex hooks and transcript location, for the later adapter.

## 17. Publishing

MIT license. The repository owner (personal or company GitHub) is undecided. Nothing gets pushed or published to npm until the owner decides.
