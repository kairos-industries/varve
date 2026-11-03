# Install from GitHub, with dist/ committed

Status: accepted. The private-repository part is superseded by [ADR 0008](0008-public-repository-at-pomess.md).

Temporal Atlas is shared with colleagues from a private GitHub repository and installed with `npm install -g github:pomess/temporal-atlas`. It is not published to npm: `package.json` has `"private": true`, and nothing in the code or docs runs `npx temporal-atlas`, because that name is unclaimed on the registry and anyone could publish a package under it.

The compiled `dist/` is committed. A git install then needs nothing but the runtime dependencies. The compile script is named `compile`, not `build`: npm prepares a git dependency (a full install with dev dependencies inside the clone) when the package has a `build`, `prepare` or install script, and in a global install that inner install ran against the global folder and left the package missing. CI rebuilds `dist/` on every push and fails if it differs from what is committed.

## Considered options

- Publish to npm, public or under a private scope: the cleanest install and upgrade path, but it puts the code on a registry, and a private scope needs paid npm seats for every colleague.
- Keep `prepare` and build on install: every install downloads TypeScript and the test tools, and global git installs broke as above.
- GitHub release tarballs: release assets of a private repository need an authenticated download, which `npm install <url>` does not do.
