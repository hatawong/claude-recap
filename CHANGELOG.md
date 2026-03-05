# Changelog

## [1.0.1] - 2026-03-05

### Bug Fixes

- **Fix cold-read hang on large transcripts** — `claude -p` hangs indefinitely when transcript (90KB+) is passed as command-line argument. Now uses stdin pipe instead. ([#cold-summarize])
- **Fix cold-read fallback skipped by `set -e`** — When `claude -p` is killed by timeout, `wait` returns non-zero and `set -e` exits the script, skipping fallback logic. Now wrapped in `if/else`. ([#cold-summarize])
- **Fix `Terminated: 15` leaking into summaries** — Incorrect redirect order (`2>/dev/null 2>&1`) sent kill messages to stdout. Fixed by removing `2>&1`. ([#cold-summarize])
- **Fix user message misclassification in extract-topic** — User messages that initiate a topic switch were assigned to the previous topic. Now uses lookahead strategy: user messages are held until the next assistant message determines their topic. ([#extract-topic])

### Improvements

- **Skip LLM fallback after compaction** — When `.compacted` exists and cold-read fails, `save-topic.sh` now exits without writing instead of using a degraded LLM summary. `archive-pending` will retry later. ([#save-topic])
- **Anti-pattern-copy prompt** — Added "Do NOT copy or build upon any previous summary" rule to `/save-topic` skill to prevent LLM from producing progressively degraded summaries. ([#SKILL.md])
- **Reduce cold-read timeout** — Default `COLD_TIMEOUT` reduced from 300s to 120s. ([#cold-summarize])

### Technical

- 116 script-level tests passing
- Added `COLD_TIMEOUT` env var to 4 test cases to prevent test hangs

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
