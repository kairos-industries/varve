# Contributing

Changes come in as pull requests. Fork the repository, push your branch to your fork, and open a pull request against `main`. The maintainer reviews it, and merges it once it is ready and CI passes. Only the maintainer can push to this repository; the first CI run of a new contributor's pull request waits for the maintainer's approval.

## Setup

```sh
npm install
npm test           # unit and integration tests; none call a model
npm run typecheck
npm run compile    # rebuilds dist/
```

To try a change in your own Claude Code, point the MCP server at your build:

```sh
claude mcp add varve --scope user -e VARVE_DIR=$HOME/Varve -- node "$PWD/dist/cli/main.js"
```

Run `npm run compile` after every change; the server runs what is in `dist/`.

## dist/ is committed

People install Varve straight from GitHub (`npm install -g github:pomess/varve`), so the compiled `dist/` is part of the repository and every change to `src/` comes with its rebuilt `dist/` in the same commit. CI fails when they differ.

The script is called `compile`, not `build`, on purpose: when a package installed from git has a `build` or `prepare` script, npm runs a full install inside the clone first, and with `-g` that breaks the global install.

## Rules

- **Tests never call a model** and never use a search model you have installed (`test/vitest.config.ts` points them at an empty folder). Use the fake clock in `test/helpers.ts` for anything time-based, a fake runner for `tidy` (see `test/tidy.test.ts`), and a hand-built model for search (see `test/search.test.ts`).
- **Changes to search or the brief come with a benchmark run.** Put the before and after scores of `varve bench --fixture` in the pull request.
- **Use the vocabulary in [docs/CONTEXT.md](../docs/CONTEXT.md).** A scope is not a project, a rollup is not a compaction, sealed is not closed.
- **The Markdown files are the source of truth.** Anything the server knows must be readable from the atlas folder; `.atlas/` holds only registries, locks and capture progress that can be rebuilt.
- **Human edits win.** Never overwrite a note whose body no longer matches its `atlas_hash`.
- **Never copy client data into the repo.** Test fixtures use made-up projects.
- Record design decisions as ADRs in `docs/adr/`.

## Releasing

The package is not published to npm (`"private": true`). To release:

1. Update [CHANGELOG.md](../docs/CHANGELOG.md) and the version in `package.json` and `src/version.ts`.
2. Run `npm run typecheck && npm test && npm run compile` and commit, `dist/` included.
3. Run `varve bench --fixture --sweep --json > docs/benchmark/fixture-<version>.json` with the search model installed. If the scores moved, update [BENCHMARK.md](../docs/BENCHMARK.md) and redraw the README figures with `npm run charts`.
4. Tag the commit (`git tag v0.4.0`) and push the tag. People pin a version with `npm install -g github:pomess/varve#v0.4.0`.
