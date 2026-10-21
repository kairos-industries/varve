# Contributing

## Setup

```sh
npm install
npm test           # unit and integration tests; none call a model
npm run typecheck
npm run build
```

To try a change in your own Claude Code, point the MCP server at your build:

```sh
claude mcp add temporal-atlas --scope user -e TEMPORAL_ATLAS_DIR=$HOME/TemporalAtlas -- node "$PWD/dist/cli/main.js"
```

Run `npm run build` after every change; the server runs what is in `dist/`.

## Rules

- **Tests never call a model.** Use the fake clock in `test/helpers.ts` for anything time-based and a fake runner for `tidy` (see `test/tidy.test.ts`).
- **Use the vocabulary in [CONTEXT.md](CONTEXT.md).** A scope is not a project, a rollup is not a compaction, sealed is not closed.
- **The Markdown files are the source of truth.** Anything the server knows must be readable from the atlas folder; `.atlas/` holds only registries, locks and capture progress that can be rebuilt.
- **Human edits win.** Never overwrite a note whose body no longer matches its `atlas_hash`.
- **Never copy client data into the repo.** Test fixtures use made-up projects.
- Record design decisions as ADRs in `docs/adr/`.

## Releasing

`npm publish` runs typecheck, tests and build first (`prepublishOnly`). Update [CHANGELOG.md](CHANGELOG.md) and the version in `package.json` and `src/version.ts`.
