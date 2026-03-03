# Changelog

## [1.0.0] - 2026-03-04

### Features

- **Topic-based automatic archival** — Stop hook detects topic changes via topic tags, archives summaries to per-session Markdown files
- **Cross-session memory injection** — SessionStart hook injects topic history and user preferences into each new session
- **Compaction recovery** — Cold-reads from JSONL transcripts when context is compacted, ensuring no context loss
- **`/remember` skill** — Persist user preferences globally or per-project to REMEMBER.md
- **`/save-topic` skill** — Manually checkpoint current topic progress mid-conversation
- **`/list-topics` skill** — View all topics discussed in the current session
- **Delayed archival** — Background process (`archive-pending.sh`) archives topics from past sessions that weren't archived at exit
- **Plugin system support** — Installable via Claude Code plugin marketplace
- **Development tools** — `dev-register.sh` / `dev-unregister.sh` for local development without plugin system

### Technical

- Pure shell (bash) + Node.js, no external dependencies
- 115 script-level tests passing
- POSIX-compatible path handling (`pwd -P`) for cross-platform support
- `MEMORY_HOME` env var for custom storage location
