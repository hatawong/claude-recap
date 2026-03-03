<h1 align="center">Claude-Recap</h1>

<p align="center">
  <em>Topic-based automatic memory for Claude Code — never lose context across sessions or compactions.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  <img src="https://img.shields.io/badge/shell-bash-green" alt="Shell" />
  <img src="https://img.shields.io/badge/Node.js-18+-339933" alt="Node.js" />
  <img src="https://img.shields.io/badge/Claude_Code-plugin-D97757" alt="Claude Code Plugin" />
</p>

<p align="center">
  <img src="demo.gif" alt="Claude-Recap demo: automatic topic archival and cross-session memory" width="800" />
</p>

---

## The Problem

Claude Code forgets everything between sessions. Switch topics mid-conversation and the previous context is gone. Hit a context compaction and your working state evaporates. Start a new session and you're explaining the same project from scratch.

## What Claude-Recap Does

Two shell hooks that run automatically — zero manual effort:

- **Automatic topic archival** — Every response gets a topic tag. When the topic changes, the previous one is summarized and saved to a Markdown file.
- **Context injection** — Each new session starts with your topic history and remembered preferences injected automatically.
- **Compaction recovery** — When Claude Code compacts your context, Claude-Recap cold-reads from the JSONL transcript to rebuild accurate summaries. Nothing is lost.
- **`/remember` skill** — Tell Claude to remember preferences across sessions: "always use bun", "never auto-commit". Stored in plain Markdown.

Everything is stored locally as Markdown files in `~/.memory/`. No database, no cloud, no dependencies beyond bash and Node.js.

## Quick Start

### Plugin install (recommended)

```bash
# 1. Register the marketplace
/plugin marketplace add hatawong/claude-recap

# 2. Install the plugin (choose User scope for all projects)
/plugin install claude-recap@claude-recap-marketplace

# 3. Restart Claude Code to activate hooks
```

> **Note:** After install, restart Claude Code for hooks to take effect. `/remember` works immediately, but topic features (`/save-topic`, `/list-topics`, auto-archival) require the restart to inject the Topic Tag Rule.

### Manual install (without plugin system)

```bash
git clone https://github.com/hatawong/claude-recap.git
cd claude-recap
./scripts/dev-register.sh /path/to/your/project
```

This writes hook entries directly into your project's `.claude/settings.json`.

## How It Works

```
SessionStart hook                          Stop hook
     │                                         │
     ▼                                         ▼
  Inject into session:                   Compare topic tag
  • REMEMBER.md (preferences)            with .current_topic
  • Topic history                              │
  • Topic Tag Rule                    ┌────────┴────────┐
     │                                │                 │
     ▼                             Same topic      Topic changed
  Claude responds with              → pass            → exit 2
  topic tag: › `slug`                              → LLM writes summary
     │                                             → script archives to
     ▼                                               ~/.memory/
  Every response tagged
  automatically                 ┌─────────────────────────┐
                                │  Compaction recovery:    │
                                │  .compacted detected →   │
                                │  cold-read from JSONL →  │
                                │  accurate summary saved  │
                                └─────────────────────────┘
```

## Features

| Feature | How |
|---------|-----|
| Topic-based archival | Stop hook detects topic changes, archives with summaries |
| Cross-session memory | SessionStart hook injects previous topics + preferences |
| Compaction recovery | Cold-reads JSONL transcripts when context is truncated |
| `/remember` | Persist preferences globally or per-project |
| `/save-topic` | Manually checkpoint current topic progress |
| `/list-topics` | View all topics discussed in current session |
| Delayed archival | Background process archives topics from past sessions |
| 100% local | Plain Markdown in `~/.memory/`, no cloud, no database |

## Storage

All data lives in `~/.memory/` (configurable via `MEMORY_HOME` env var):

```
~/.memory/
  REMEMBER.md                          # Global preferences
  projects/
    {project-path-encoded}/            # e.g. -Users-you-my-app
      REMEMBER.md                      # Project preferences
      {session-id}/
        .current_topic                 # Active topic slug
        01-setup-auth.md               # Topic summary (auto-numbered)
        02-fix-login-bug.md
```

## Comparison

| | Claude-Recap | claude-mem | Manual CLAUDE.md |
|---|---|---|---|
| Granularity | Per-topic | Per-session dump | Manual |
| Automation | Fully automatic | Automatic | Manual |
| Compaction survival | Yes (cold-read recovery) | No | N/A |
| Storage | Local Markdown | ChromaDB | Local Markdown |
| Dependencies | bash, Node.js | Python, ChromaDB | None |
| Topic separation | Automatic | None | Manual |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_HOME` | `~/.memory` | Root directory for all memory data |

## Uninstall

```bash
/plugin uninstall claude-recap@claude-recap-marketplace
```

Your data in `~/.memory/` is preserved — uninstalling does not delete memory files. Reinstalling restores full functionality with existing data.

## Update

```bash
# Pull latest and update plugin cache
/plugin marketplace update claude-recap-marketplace
```

Or enable auto-update via `/plugin` → Marketplaces → "Enable auto-update".

## Documentation

- [Architecture](docs/architecture.md) — How the hooks, scripts, and cold-read pipeline work
- [Design Decisions](docs/design-decisions.md) — Why topic-based, why Markdown, why hooks
- [FAQ & Troubleshooting](docs/faq.md) — Common questions and solutions
- [Advanced Usage](docs/advanced-usage.md) — Custom storage, dev mode, manual setup

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
