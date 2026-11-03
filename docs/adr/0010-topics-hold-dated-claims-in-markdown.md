# Topics hold dated claims, in Markdown

Status: accepted.

The time layers record what happened and when. They do not answer "what do we know about auth now, since when, and what replaced what". Two known approaches do: a temporal knowledge graph (for example Zep's Graphiti), where facts are graph edges with validity times in a database, and an LLM wiki (as described by Andrej Karpathy), where the model compiles sources into topic pages in Markdown, with no notion of time.

Varve's topic notes combine the two in Markdown. Each line is a claim or an open item with the day it started, the note it came from and an Obsidian block id. A replaced or closed claim, and a resolved item, moves to History with the day it ended; nothing is deleted. Links between topics are ordinary wikilinks, so Obsidian's graph shows them.

Claims are written where summaries already are: by the writer of a rollup (the agent through `seal`, or `tidy`), who sees the current claims and their ids, and by an agent during a session through `topic`. The server still calls no model. It checks every operation (ids exist, days are real and inside the period) before writing, and refuses the whole update on the first bad one.

## Considered options

- A graph database: typed queries and validity times, but a second store that is not the Markdown, against ADR 0002.
- Extracting facts from every logged event: more claims, sooner, but more noise and a model call per event, against ADR 0001.
- Prose "What we know now", rewritten each time (0.4 and before): readable, but it loses what was true before and when it changed.
