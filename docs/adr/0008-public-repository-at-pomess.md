# Public repository at pomess/temporal-atlas

Supersedes the private-repository part of ADR 0005. Temporal Atlas is open source at `pomess/temporal-atlas`, so anyone installs it with `npm install -g github:pomess/temporal-atlas` and no GitHub access to set up. Benchmark reports from other people's atlases need a public place to arrive, and a public repository with an issue template is the simplest one.

The rest of ADR 0005 stands: the package is not published to npm, and `dist/` is committed so a git install needs no build step.

Before the repository was made public, its files and full git history were checked for client names, internal URLs and secrets.
