#!/usr/bin/env bash
# archive-pending.sh — Standalone archival: scan → extract → summarize → write
# Self-starts LLM via `claude -p` for cold-reader summarization.
# Runs as independent process, not within Agent context.
#
# Usage: archive-pending.sh <project-dir> <current-session-id> <plugin-root> [--dry-run]
#
# --dry-run: scan and extract only, print what would be summarized, skip LLM call

set -euo pipefail

PROJECT_DIR="$1"
CURRENT_SESSION_ID="$2"
PLUGIN_ROOT="$3"
DRY_RUN=false
if [ "${4:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

EXTRACT_SCRIPT="$PLUGIN_ROOT/scripts/extract-topic.js"

# Max topics to archive per run (across all sessions)
MAX_PENDING=3

if [ ! -d "$PROJECT_DIR" ]; then
  exit 0
fi

# Resolve project ID for JSONL path lookup
PROJECT_ID=$(basename "$PROJECT_DIR")
CLAUDE_PROJECTS_DIR="$HOME/.claude/projects/$PROJECT_ID"

pending_count=0

# Scan session directories (most recently modified first)
for session_dir in $(find "$PROJECT_DIR" -mindepth 1 -maxdepth 1 -type d -print0 | xargs -0 ls -td 2>/dev/null); do
  session_id=$(basename "$session_dir")

  # Skip current session and non-UUID directories
  if [ "$session_id" = "$CURRENT_SESSION_ID" ]; then
    continue
  fi
  if [ "$session_id" = "unknown" ]; then
    continue
  fi

  # .current_topic must exist — proves this session used topic tracking
  if [ ! -f "$session_dir/.current_topic" ]; then
    continue
  fi

  # Skip sessions with .archive-skipped marker
  if [ -f "$session_dir/.archive-skipped" ]; then
    continue
  fi

  # Find corresponding JSONL
  jsonl_path="$CLAUDE_PROJECTS_DIR/${session_id}.jsonl"
  if [ ! -f "$jsonl_path" ]; then
    continue
  fi

  # Get all topics from JSONL (excluding __untagged__)
  all_topics=$(node "$EXTRACT_SCRIPT" "$jsonl_path" __all__ 2>/dev/null | grep -v '^__untagged__$') || true
  if [ -z "$all_topics" ]; then
    continue
  fi

  # Iterate all topics, archive any that are missing
  total_topics=$(echo "$all_topics" | wc -l | tr -d ' ')
  topic_seq=0
  while IFS= read -r slug; do
    topic_seq=$((topic_seq + 1))
    [ -z "$slug" ] && continue

    seq=$(printf "%02d" "$topic_seq")
    target_file="$session_dir/${seq}-${slug}.md"

    # Already archived? Check canonical path or any seq variant (v3 legacy may have different seq)
    existing_file=$(find "$session_dir" -maxdepth 1 -name "*-${slug}.md" -not -name ".*" 2>/dev/null | head -1)
    if [ -n "$existing_file" ]; then
      # For the last topic, check if JSONL has newer messages than the archived file
      if [ "$topic_seq" -eq "$total_topics" ]; then
        archived_end=$(sed -n 's/^> .* — \(.*\)$/\1/p' "$existing_file")
        jsonl_end=$(node "$EXTRACT_SCRIPT" "$jsonl_path" "$slug" 2>/dev/null | head -2 | tail -1 | sed -n 's/.*topic_end: \(.*\) -->.*/\1/p') || true
        if [ -n "$archived_end" ] && [ -n "$jsonl_end" ] && [ "$jsonl_end" \> "$archived_end" ]; then
          echo "STALE: ${existing_file} (archived=$archived_end, jsonl=$jsonl_end), re-archiving" >&2
          rm -f "$existing_file"
        else
          continue
        fi
      else
        continue
      fi
    fi

    # Extract conversation for this topic
    extracted_file="$session_dir/.extracted-${slug}.md"

    if [ ! -f "$extracted_file" ]; then
      if ! node "$EXTRACT_SCRIPT" "$jsonl_path" "$slug" > "$extracted_file" 2>/dev/null; then
        rm -f "$extracted_file"
        continue
      fi
      if [ ! -s "$extracted_file" ]; then
        rm -f "$extracted_file"
        continue
      fi
    fi

    if [ "$DRY_RUN" = "true" ]; then
      echo "PENDING: topic=${slug} session=${session_id} extracted=${extracted_file} target=${target_file}"
    else
      # Check claude is available
      if ! command -v claude &>/dev/null; then
        echo "WARNING: claude CLI not found, skipping LLM summarization for ${slug}" >&2
        continue
      fi

      # Parse time range from extracted file
      START_TIME=$(head -1 "$extracted_file" | sed -n 's/.*topic_start: \(.*\) -->.*/\1/p')
      END_TIME=$(head -2 "$extracted_file" | tail -1 | sed -n 's/.*topic_end: \(.*\) -->.*/\1/p')
      START_TIME="${START_TIME:-$(date +"%Y-%m-%d %H:%M")}"
      END_TIME="${END_TIME:-$(date +"%Y-%m-%d %H:%M")}"

      # Cold-reader summarization via shared script
      COLD_SUMMARIZE="$PLUGIN_ROOT/scripts/cold-summarize.sh"
      SUMMARY=$(bash "$COLD_SUMMARIZE" "$extracted_file" "$PLUGIN_ROOT" "$jsonl_path") || true

      if [ -n "$SUMMARY" ]; then
        cat > "$target_file" <<EOF
# Topic: $slug

> $START_TIME — $END_TIME

$SUMMARY
EOF
        echo "ARCHIVED: ${target_file}"
        rm -f "$extracted_file"
      else
        echo "WARNING: LLM summarization failed for ${slug}, extracted file kept at ${extracted_file}" >&2
      fi
    fi

    pending_count=$((pending_count + 1))
    if [ "$pending_count" -ge "$MAX_PENDING" ]; then
      break 2
    fi
  done <<< "$all_topics"

  # If all topics failed extraction, mark session to avoid eternal retries
  archived_count=$(find "$session_dir" -maxdepth 1 -name "*.md" -not -name ".*" 2>/dev/null | wc -l)
  extracted_count=$(find "$session_dir" -maxdepth 1 -name ".extracted-*" 2>/dev/null | wc -l)
  if [ "$archived_count" -eq 0 ] && [ "$extracted_count" -eq 0 ]; then
    echo "no_extractable_topics" > "$session_dir/.archive-skipped"
  fi
done
