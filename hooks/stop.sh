#!/usr/bin/env bash
# stop.sh — Stop hook: detect topic change and trigger archival
# Extracts › `slug` from last_assistant_message,
# compares with .current_topic. If changed, exit 2 with direct bash command for LLM to archive.

set -euo pipefail

INPUT=$(cat)

# Anti-recursion: if already inside a stop hook cycle, pass through
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# Extract topic tag from last assistant message
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')
# Only match a line that is exclusively the topic tag (anchored ^...$)
# Format: › `slug` — Unicode arrow + backtick-wrapped slug
# Single quotes intentional: sed regex, not shell expansion
# shellcheck disable=SC2016
NEW_TOPIC=$(echo "$LAST_MSG" | head -1 | sed -n 's/^› `\([a-z0-9-]*\)`$/\1/p')

# Debug: log what we got
echo "[stop.sh] extracted topic tag: '${NEW_TOPIC}'" >&2

# If no tag found, pass through (LLM didn't follow the rule)
if [ -z "$NEW_TOPIC" ]; then
  echo "[stop.sh] no topic tag found in last_assistant_message, pass through" >&2
  exit 0
fi

# Read current topic from per-session state file
MEMORY_ROOT="${MEMORY_HOME:-$HOME/.memory}"
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
PROJECT_ID="${CWD//\//-}"
SESSION_DIR="$MEMORY_ROOT/projects/${PROJECT_ID}/${SESSION_ID}"
TOPIC_FILE="$SESSION_DIR/.current_topic"
OLD_TOPIC=$(cat "$TOPIC_FILE" 2>/dev/null || echo "none")

echo "[stop.sh] old_topic='${OLD_TOPIC}', new_topic='${NEW_TOPIC}'" >&2

# Compare
if [ "$NEW_TOPIC" = "$OLD_TOPIC" ]; then
  echo "[stop.sh] topic unchanged, pass through" >&2
  exit 0
fi

# First topic in session — just register, nothing to archive
if [ "$OLD_TOPIC" = "none" ]; then
  mkdir -p "$SESSION_DIR"
  echo "$NEW_TOPIC" > "$TOPIC_FILE"
  echo "[stop.sh] first topic registered: ${NEW_TOPIC}" >&2
  exit 0
fi

# Topic changed — archive old topic via direct bash command
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

SUMMARY_TEMPLATE=$(cat "${PLUGIN_ROOT}/scripts/topic-tmpl.md")
cat >&2 <<TOPIC_EOF
Topic changed from '${OLD_TOPIC}' to '${NEW_TOPIC}'.

Archive the old topic NOW. Write a factual summary of '${OLD_TOPIC}' and run this command:

bash "${PLUGIN_ROOT}/scripts/set-topic.sh" "${OLD_TOPIC}" "${NEW_TOPIC}" "${SESSION_ID}" "<your_summary>"

Replace <your_summary> with a structured summary using this format (section headings in English, content in user's language, skip empty sections):

${SUMMARY_TEMPLATE}

Rules: State facts only. No AI filler language. The script adds the header and time range automatically.
TOPIC_EOF
exit 2
