# Renamed to Varve, with the old names kept

Status: accepted.

Temporal Atlas is now Varve. "Atlas" is a crowded name among developer tools, and the project needed a short, searchable name for a public repository and a CLI. A varve is one year's layer of lake sediment, which is how this tool stores work: thin layers that are read in order to tell time.

The rename changes the product, the CLI (`varve`), the MCP server name (`varve`), the environment variables (`VARVE_DIR`, `VARVE_MODELS`, `VARVE_CHILD`), the default folder (`~/Varve`), the model cache (`~/.cache/varve/models`), the launchd label (`io.varve.tidy`) and the repository (`pomess/varve`). The old ones keep working, so nobody has to change anything to upgrade: the `temporal-atlas` command is a second name for the same binary, `TEMPORAL_ATLAS_*` variables are read when the new ones are unset, an existing `~/TemporalAtlas` is used when `~/Varve` does not exist, a model in the old cache is used, and `setup` replaces an MCP registration and a nightly job under the old name.

The on-disk format keeps its names: `atlas.config.json`, `.atlas/`, the `atlas:` frontmatter key and `atlas_hash`. "Atlas" stays as the word for the folder of notes. Renaming them would mean migrating every note in every atlas for no gain to the reader.

## Considered options

- Strata, Cairn, Engram, Logbook, Lore, Daybook: already used by agent-memory or MCP projects.
- Annals: accurate, but invites an obvious joke.
- A hard rename with a migration command: cleaner on disk, but every user's notes and hooks would have to change at once.
