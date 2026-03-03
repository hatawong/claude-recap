#!/usr/bin/env bash
# set-topic.sh — Handle topic change: archive old topic summary, update current topic state
# Called via stop.sh prompt. LLM provides summary, this script controls all file operations.
# If .compacted exists, LLM summary is discarded — cold-reads from JSONL instead (LLM context
# is truncated after compact, its summary would be inaccurate).
#
# Usage: set-topic.sh <old_topic_slug> <new_topic_slug> <session_id> <old_topic_summary>

set -euo pipefail

OLD_SLUG="$1"
NEW_SLUG="$2"
SESSION_ID="$3"
OLD_SUMMARY="$4"

# Validate slug format (defense in depth — stop.sh already validates via regex)
for slug in "$OLD_SLUG" "$NEW_SLUG"; do
  if [ "$slug" != "none" ] && ! echo "$slug" | grep -qE '^[a-z0-9-]+$'; then
    echo "Error: invalid topic slug: $slug" >&2
    exit 1
  fi
done

# Resolve memory paths
# CLAUDE_CWD: test-only override; in production pwd -P resolves symlinks (e.g. /tmp → /private/tmp)
# to match Claude Code's resolved CWD in JSON input (used by hooks for PROJECT_ID)
CWD="${CLAUDE_CWD:-$(pwd -P)}"
PROJECT_ID="${CWD//\//-}"
MEMORY_ROOT="${MEMORY_HOME:-$HOME/.memory}"
PROJECT_DIR="$MEMORY_ROOT/projects/$PROJECT_ID"
SESSION_DIR="$PROJECT_DIR/$SESSION_ID"
END_TIME=$(date +"%Y-%m-%d %H:%M")

# Resolve JSONL path and extract-topic.js for timestamp extraction
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXTRACT_SCRIPT="$PLUGIN_ROOT/scripts/extract-topic.js"
JSONL_PATH="$HOME/.claude/projects/$PROJECT_ID/${SESSION_ID}.jsonl"

mkdir -p "$SESSION_DIR"

# 1. Archive old topic (if there was one)
if [ "$OLD_SLUG" != "none" ] && [ "$OLD_SUMMARY" != "none" ]; then

  # Cold-read path: if .compacted exists, LLM context is truncated — discard LLM summary,
  # extract full conversation from JSONL and use cold-summarize.sh for accurate summarization.
  COMPACTED_FILE="$SESSION_DIR/.compacted"
  COLD_SUMMARIZE="$PLUGIN_ROOT/scripts/cold-summarize.sh"
  if [ -f "$COMPACTED_FILE" ] && [ -f "$JSONL_PATH" ] && [ -f "$EXTRACT_SCRIPT" ]; then
    echo "Compacted session detected — cold-reading from JSONL instead of LLM summary" >&2

    # Extract conversation for old topic
    EXTRACTED_FILE="$SESSION_DIR/.extracted-${OLD_SLUG}.md"
    if node "$EXTRACT_SCRIPT" "$JSONL_PATH" "$OLD_SLUG" > "$EXTRACTED_FILE" 2>/dev/null && [ -s "$EXTRACTED_FILE" ]; then
      # Parse time range from extracted file
      START_TIME=$(head -1 "$EXTRACTED_FILE" | sed -n 's/.*topic_start: \(.*\) -->.*/\1/p')
      COLD_END=$(head -2 "$EXTRACTED_FILE" | tail -1 | sed -n 's/.*topic_end: \(.*\) -->.*/\1/p')
      START_TIME="${START_TIME:-$END_TIME}"
      END_TIME="${COLD_END:-$END_TIME}"

      # Cold-reader summarization
      if COLD_SUMMARY=$(bash "$COLD_SUMMARIZE" "$EXTRACTED_FILE" "$PLUGIN_ROOT" "$JSONL_PATH"); then
        OLD_SUMMARY="$COLD_SUMMARY"
        echo "Cold-read summary generated successfully" >&2
      else
        echo "WARNING: cold-read summarization failed, falling back to LLM summary" >&2
      fi
    else
      echo "WARNING: JSONL extraction failed, falling back to LLM summary" >&2
    fi
    rm -f "$EXTRACTED_FILE"

    # Remove .compacted marker — cold-read done (or fell back to LLM summary)
    rm -f "$COMPACTED_FILE"
  fi

  # Try to get topic start time from JSONL (if not already set by cold-read path above)
  if [ -z "${START_TIME:-}" ]; then
    START_TIME="$END_TIME"
    if [ -f "$JSONL_PATH" ] && [ -f "$EXTRACT_SCRIPT" ]; then
      EXTRACTED_START=$(node "$EXTRACT_SCRIPT" "$JSONL_PATH" "$OLD_SLUG" 2>/dev/null | head -1 | sed -n 's/.*topic_start: \(.*\) -->.*/\1/p') || true
      if [ -n "$EXTRACTED_START" ]; then
        START_TIME="$EXTRACTED_START"
      fi
    fi
  fi

  # Compute canonical file path from JSONL topic order
  SEQ=""
  if [ -f "$JSONL_PATH" ] && [ -f "$EXTRACT_SCRIPT" ]; then
    SEQ=$(node "$EXTRACT_SCRIPT" "$JSONL_PATH" __all__ 2>/dev/null | grep -v '^__untagged__$' | grep -n "^${OLD_SLUG}$" | head -1 | cut -d: -f1) || true
  fi
  if [ -z "$SEQ" ]; then
    echo "Error: cannot determine topic sequence — JSONL not found or slug '$OLD_SLUG' not in topic list" >&2
    exit 1
  fi
  SEQ=$(printf "%02d" "$SEQ")
  OLD_FILE="$SESSION_DIR/${SEQ}-${OLD_SLUG}.md"

  cat > "$OLD_FILE" <<EOF
# Topic: $OLD_SLUG

> $START_TIME — $END_TIME

$OLD_SUMMARY
EOF
  echo "Saved: $OLD_FILE"
fi

# 2. Update .current_topic state (per-session)
echo "$NEW_SLUG" > "$SESSION_DIR/.current_topic"
echo "Current topic: $NEW_SLUG (session $SESSION_ID)"
