# Markdown files are the source of truth

Every note is a Markdown file with YAML frontmatter, and the server keeps no database. The search index is built in memory from the files at startup. Users can open the atlas in Obsidian, edit it by hand, and track it in git, and the server treats a hand edit as authoritative. The cost is slower startup and search on very large atlases, which an on-disk cache can fix later without changing the format.
