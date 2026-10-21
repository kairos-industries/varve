# The agent writes every summary

Status: amended by [ADR 0004](0004-tidy-may-call-a-model-when-the-user-schedules-it.md). The MCP server still never calls a model; the `tidy` command may, when the user runs or schedules it.

The server never calls a model. When a period closes, the server hands the source notes to whichever agent is connected, and that agent writes the summary through `seal`. This keeps the server free of API keys and background spending, and an open-source user needs nothing beyond the agent they already run. The cost is that rollups happen only when an agent connects, so the brief falls back to drafts until then, and a cost gate asks the user before large backlogs are summarized.

## Considered options

- Server calls a model API on a schedule: rollups happen on time, but every user needs a key and the server can spend money without anyone watching. Kept as an optional later mode.
