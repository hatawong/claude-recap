#!/usr/bin/env bash
# save-topic.sh — Save current topic summary without switching topics
# Checkpoint mid-conversation progress to a persistent file.
# If .compacted exists, LLM summary is discarded — cold-reads from JSONL instead.
# Unlike set-topic.sh, does NOT delete .compacted (topic hasn't changed, marker still needed).
#
# Usage: save-topic.sh <slug> <session_id> <summary>

set -euo pipefail

# Parse optional --cold flag (forces cold-read from JSONL, used for non-current topics)
COLD_READ=false
if [ "${1:-}" = "--cold" ]; then
  COLD_READ=true
  shift
fi

SLUG="$1"
SESSION_ID="$2"
SUMMARY="$3"

# Validate slug format (defense in depth — stop.sh already validates via regex)
if ! echo "$SLUG" | grep -qE '^[a-z0-9-]+$'; then
  echo "Error: invalid topic slug: $SLUG" >&2
  exit 1
fi

# CLAUDE_CWD: test-only override; in production pwd -P resolves symlinks (e.g. /tmp → /private/tmp)
# to match Claude Code's resolved CWD in JSON input (used by hooks for PROJECT_ID)
CWD="${CLAUDE_CWD:-$(pwd -P)}"
PROJECT_ID="${CWD//\//-}"
MEMORY_ROOT="${MEMORY_HOME:-$HOME/.memory}"
SESSION_DIR="$MEMORY_ROOT/projects/$PROJECT_ID/$SESSION_ID"
END_TIME=$(date +"%Y-%m-%d %H:%M")

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXTRACT_SCRIPT="$PLUGIN_ROOT/scripts/extract-topic.js"
JSONL_PATH="$HOME/.claude/projects/$PROJECT_ID/${SESSION_ID}.jsonl"

mkdir -p "$SESSION_DIR"

# Early-exit if --cold requested but JSONL is missing
if [ "$COLD_READ" = true ] && [ ! -f "$JSONL_PATH" ]; then
  echo "Error: --cold requires JSONL at $JSONL_PATH (not found)" >&2
  exit 1
fi

# Cold-read path: if .compacted exists, LLM context is truncated — use JSONL instead
COMPACTED_FILE="$SESSION_DIR/.compacted"
if { [ -f "$COMPACTED_FILE" ] || [ "$COLD_READ" = true ]; } && [ -f "$JSONL_PATH" ] && [ -f "$EXTRACT_SCRIPT" ]; then
  if [ "$COLD_READ" = true ]; then
    echo "Cold-read forced by --cold flag — reading from JSONL" >&2
  else
    echo "Compacted session detected — cold-reading from JSONL instead of LLM summary" >&2
  fi

  EXTRACTED_FILE="$SESSION_DIR/.extracted-${SLUG}.md"
  if node "$EXTRACT_SCRIPT" "$JSONL_PATH" "$SLUG" > "$EXTRACTED_FILE" 2>/dev/null && [ -s "$EXTRACTED_FILE" ]; then
    # Extract time range from JSONL for accurate timestamps
    COLD_START=$(head -1 "$EXTRACTED_FILE" | sed -n 's/.*topic_start: \(.*\) -->.*/\1/p')
    COLD_END=$(head -2 "$EXTRACTED_FILE" | tail -1 | sed -n 's/.*topic_end: \(.*\) -->.*/\1/p')
    if [ -n "$COLD_START" ]; then
      START_TIME="$COLD_START"
    fi
    if [ -n "$COLD_END" ]; then
      END_TIME="$COLD_END"
    fi

    # Cold-reader summarization via shared script
    COLD_SUMMARIZE="$PLUGIN_ROOT/scripts/cold-summarize.sh"
    if COLD_SUMMARY=$(bash "$COLD_SUMMARIZE" "$EXTRACTED_FILE" "$PLUGIN_ROOT" "$JSONL_PATH"); then
      SUMMARY="$COLD_SUMMARY"
      echo "Cold-read summary generated successfully" >&2
    else
      echo "WARNING: cold-read summarization failed, falling back to LLM summary" >&2
    fi
  else
    echo "WARNING: JSONL extraction failed, falling back to LLM summary" >&2
  fi
  rm -f "$EXTRACTED_FILE"
  # NOTE: .compacted is NOT deleted here — topic hasn't changed, set-topic.sh will handle it later
fi

# Ensure .current_topic is set (may not exist if save-topic is called before stop hook registers)
if [ ! -f "$SESSION_DIR/.current_topic" ]; then
  echo "$SLUG" > "$SESSION_DIR/.current_topic"
fi

# Compute canonical file path from JSONL topic order
SEQ=""
if [ -f "$JSONL_PATH" ] && [ -f "$EXTRACT_SCRIPT" ]; then
  SEQ=$(node "$EXTRACT_SCRIPT" "$JSONL_PATH" __all__ 2>/dev/null | grep -v '^__untagged__$' | grep -n "^${SLUG}$" | head -1 | cut -d: -f1) || true
fi
if [ -z "$SEQ" ]; then
  echo "Error: cannot determine topic sequence — JSONL not found or slug '$SLUG' not in topic list" >&2
  exit 1
fi
SEQ=$(printf "%02d" "$SEQ")
TARGET="$SESSION_DIR/${SEQ}-${SLUG}.md"

# Preserve original start time if file already exists
if [ -f "$TARGET" ]; then
  ORIG_START=$(sed -n 's/^> \(.*\) — .*/\1/p' "$TARGET")
  START_TIME="${ORIG_START:-${START_TIME:-$END_TIME}}"
fi

cat > "$TARGET" <<EOF
# Topic: $SLUG

> ${START_TIME:-$END_TIME} — $END_TIME

$SUMMARY
EOF
echo "Saved: $TARGET"
