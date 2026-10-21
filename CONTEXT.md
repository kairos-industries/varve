# Temporal Atlas

A memory for AI agents that records what was done across every conversation, layered by time. Recent work is kept in full detail; older work is kept as progressively shorter summaries.

## Language

### The store

**Atlas**:
The whole collection of notes the server reads and writes, stored as Markdown in one folder.
_Avoid_: vault (reserved for the Obsidian vault the atlas may sit inside), memory, cache

**Scope**:
A named area of work that every session belongs to, usually one client or one project.
_Avoid_: project, workspace, client, repo

**General scope**:
The scope for sessions that match no other scope. Everything in it is visible from every scope.

**Isolated scope**:
A scope whose notes are visible only from sessions inside that scope.
_Avoid_: private, confidential

**Topic**:
A note holding durable knowledge about one subject within a scope, with its current state on top and a dated timeline below.
_Avoid_: entity, concept, knowledge note

### Time

**Layer**:
One of the five zoom levels: session, day, week, month, year. Each layer above session is shorter per period than the one below it.
_Avoid_: level, tier

**Period**:
One specific span of time at one layer, such as the day 2026-10-08 or the week 2026-W41.
_Avoid_: bucket, interval, window

**Period note**:
The note for one period in one scope.

**Index note**:
The note for one period across all non-isolated scopes, listing each scope's headline for that period.
_Avoid_: global summary

**Day boundary**:
The local time at which one day ends and the next begins, 04:00 by default.

**Open period**:
A period whose end has not yet passed.

**Closed period**:
A period whose end has passed.

### Work being recorded

**Session**:
One agent conversation, from its first write to its close.
_Avoid_: chat, run, thread, conversation (in code)

**Segment**:
The part of a session that falls within one day. A session that crosses a day boundary has more than one segment.

**Event**:
A timestamped, typed entry an agent logs during a session: decision, change, finding, todo or note.
_Avoid_: log entry, message

**Activity**:
The part of a session note the capture hooks write from the transcript after each turn, without a model: the session title, requests, files changed, commits, pushes and PRs, and the last reply.
_Avoid_: digest, log (in prose)

**Headless session**:
A session whose every prompt came from a program (`claude -p`, the SDK) rather than a person. The hooks do not record it unless `capture.headless` is on.

**Orphan session**:
A closed session that has no events, no summary and no activity, so it can only be summarized from its transcript. Since activity capture, only sessions recorded by v0.1 hooks or by clients without capture are orphans. No day waits for one.

### Summarizing

**Draft**:
The note for an open period, assembled from the notes beneath it without using a model.
_Avoid_: live note, preview

**Rollup**:
Writing the summary of one closed period from the notes one layer down, done by the connected agent.
_Avoid_: compaction, consolidation, summary job

**Sealed**:
The state of a period note once its rollup is written. A sealed note changes only through an amendment or a human edit.
_Avoid_: locked, final, closed (closed refers to time, sealed to the note)

**Pending rollup**:
A closed period that has no sealed note yet, or whose sealed note is stale.

**Stale**:
The state of a sealed note whose source notes changed after it was sealed.

**Amendment**:
A dated correction appended to a sealed note, with the reason for it.

**Checkpoint**:
A moment when the server looks for pending rollups: session start, a day change during a session, session close, or an explicit tidy request.
_Avoid_: sync, maintenance run

**Tidy**:
A run of `temporal-atlas tidy` that writes pending rollups with `claude -p`, inside a token and dollar budget. A nightly tidy is one the user scheduled with `install nightly`.

**Cost gate**:
The token threshold above which pending rollups need the user's confirmation before the agent does them.
_Avoid_: budget (reserved for length targets)

**Length target**:
The intended size of one period note at a given layer, in tokens.

### Reading

**Brief**:
The default view of the atlas for one scope: the most recent periods at each layer, sized to fit at the start of a session.
_Avoid_: digest, context, summary

**Zoom**:
Reading one period note together with the list of notes beneath it.
