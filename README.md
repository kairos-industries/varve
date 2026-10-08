# Temporal Atlas

A memory for AI agents, layered by time. Temporal Atlas is an MCP server that records what you and your agents do, session by session, and summarizes it into day, week, month and year notes. Each layer is shorter than the one below it. When an agent starts, it gets a brief of recent work. It can open any period or search everything that came before.

The atlas is a folder of Markdown files with YAML frontmatter and `[[wikilinks]]`, so you can open it in Obsidian, edit it by hand, and keep it in git.

```
year      2026                     ~800 tokens
month     2026-10                  ~400 tokens
week      2026-W41                 ~500 tokens
day       2026-10-08               ~600 tokens
session   2026-10-08T1432-k3f9q2   full detail
```

The server never calls a model. The agent you already run writes the summaries, and a cost gate asks you before a large backlog is summarized.

## Install

Requires Node 20 or later.

```sh
npx -y temporal-atlas init ~/TemporalAtlas
```

Then add the server to your agent.

**Claude Code**

```sh
claude mcp add temporal-atlas --scope user -e TEMPORAL_ATLAS_DIR=$HOME/TemporalAtlas -- npx -y temporal-atlas
npx -y temporal-atlas install claude-code   # optional: capture sessions automatically
```

**Codex**

```sh
codex mcp add temporal-atlas --env TEMPORAL_ATLAS_DIR=$HOME/TemporalAtlas -- npx -y temporal-atlas
```

**Cursor, Windsurf, VS Code and others**: add an MCP server with command `npx`, arguments `["-y", "temporal-atlas"]` and environment `TEMPORAL_ATLAS_DIR`.

To keep the atlas inside an existing Obsidian vault, point `TEMPORAL_ATLAS_DIR` at a folder in the vault, such as `MyVault/Atlas`. The server writes only inside that folder.

## How it works

**Scopes.** Every session belongs to a scope, usually a project or client, detected from the git remote or folder. Sessions outside any project go to `general`. Each scope gets its own day, week, month and year notes. Index notes list every scope's headline for a period. A scope marked isolated is invisible from every other scope, which keeps client work apart.

**Sessions.** The agent calls `log` for decisions, changes and findings as it works, and `close_session` with a headline and summary at the end. A session that runs past the day boundary (04:00 by default) is split into one segment per day.

**Drafts and sealing.** While a period is open, its note is a draft assembled from the notes beneath it, at no token cost. Once the period ends, it becomes a pending rollup. The agent reads the sources with `summarize` and writes the summary with `seal`. Days roll up into weeks and months, and months into years.

**Checkpoints.** The server looks for pending rollups when a session starts, at the first call after the day boundary, at session close, and whenever you ask it to tidy the atlas. Rollups under the cost gate (30,000 tokens by default) run without asking; larger batches wait for your confirmation.

**Corrections.** Your edits always win. If you change a note in Obsidian, the server keeps your version and marks the summaries built on it stale, so they get redone. Agents correct sealed notes with `amend`, which adds a dated entry instead of rewriting history.

**Topics.** Durable knowledge ("Auth design", "Pricing model") lives in topic notes with the current state on top and a dated timeline below. The server offers an existing topic with a similar name before creating a duplicate.

## Tools

| Tool | Does |
|---|---|
| `brief` | The layered view of recent work in a scope |
| `log` | Records a decision, change, finding, todo or note |
| `close_session` | Writes the session summary; returns pending rollups |
| `pending` | Lists rollups waiting, with token estimates and the cost gate |
| `summarize` | Returns the sources and instructions for one rollup |
| `seal` | Saves a rollup and seals the period |
| `zoom` | Opens a period or session and lists what is beneath it |
| `search` | Keyword search with scope, layer and date filters |
| `topic` | Reads, creates or updates a topic note |
| `scopes` | Lists scopes; isolates, maps or merges them |
| `amend` | Adds a correction to a sealed note |

## Command line

```
temporal-atlas                      run the MCP server over stdio
temporal-atlas init [dir]           create an atlas
temporal-atlas install claude-code  add the capture hooks (shows the change and asks first)
temporal-atlas doctor               report pending rollups, orphan sessions and broken notes
```

## Configuration

`atlas.config.json` in the atlas folder:

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

The server replaces likely secrets (API keys, tokens, private keys, passwords in connection strings) with `[redacted:<kind>]` before writing. Add your own patterns as `{ "name": "...", "pattern": "regex" }`.

## Layout

```
TemporalAtlas/
  atlas.config.json
  scopes/<scope>/sessions/2026/10/2026-10-08T1432-k3f9q2.md
  scopes/<scope>/days/2026/2026-10-08 <scope>.md
  scopes/<scope>/weeks/2026/2026-W41 <scope>.md
  scopes/<scope>/months/2026/2026-10 <scope>.md
  scopes/<scope>/years/2026 <scope>.md
  scopes/<scope>/topics/<Topic>.md
  index/days|weeks|months|years/...
  .atlas/   scope rules, session registry, rollup locks
```

## Development

```sh
npm install
npm test          # unit and integration tests; none call a model
npm run build
```

The design is in [DESIGN.md](DESIGN.md) and the vocabulary in [CONTEXT.md](CONTEXT.md).

## License

MIT
