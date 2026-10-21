# Tidy may call a model when the user schedules it

ADR 0001 kept every model call inside the connected agent. In practice that left rollups undone: across 12 days of real use, 189 sessions produced no sealed note, because agents rarely had a reason to tidy and backlogs passed the cost gate. `temporal-atlas tidy` now writes rollups itself by running the Claude Code CLI (`claude -p`) the user already has signed in, one call per rollup, and `temporal-atlas install nightly` schedules it.

The MCP server still never calls a model. Only the `tidy` command does, and only when the user runs it or installs the schedule. Each run stops at a token budget and a dollar budget (`tidy.maxTokens`, `tidy.maxUsd`), passes `--max-budget-usd` to every call, and logs each rollup with its cost to `.atlas/tidy.log`. The child runs with no tools, no MCP servers, no user hooks and no saved transcript, and with `TEMPORAL_ATLAS_CHILD=1` so the atlas's own hooks record nothing.

## Considered options

- Call the Anthropic API directly: needs an API key, which many Claude Code users do not have. The CLI reuses whatever sign-in the user already set up.
- Keep agent-only rollups and nag harder: the agent's context is for the user's task, and asking the user to approve a backlog every few days did not happen in practice.
