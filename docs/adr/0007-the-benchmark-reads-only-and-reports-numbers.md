# The benchmark reads only and reports numbers

Temporal Atlas is used on client work, so the benchmark has to be safe to run on any atlas and its report safe to share. `temporal-atlas bench` never writes to the atlas (it calls search and the brief directly, without opening an MCP session) and calls no model. Its report holds the version, platform, Node version, model id, counts and scores, and no note text, scope names or note names. A test checks every string in a report against an allow list.

Comparable numbers come from a bundled fixture atlas with fixed session ids. Real-atlas numbers come from probes built from the user's own logged events and sealed headlines. Those flatter keyword search, because the query words are in the note. The optional `--paraphrase` tier corrects for that with a model: it sends only the queries, through the user's own `claude` CLI, after asking, within a dollar cap.

## Considered options

- A public benchmark such as LoCoMo or LongMemEval: comparable with other memory tools, but those are chat-persona datasets, not coding work history, and running them needs model calls on every question.
- Model-judged answers on the user's atlas: closer to real use, but every colleague's run would cost money and send note text to a model.
