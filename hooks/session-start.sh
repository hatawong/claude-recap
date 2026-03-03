#!/usr/bin/env bash
# session-start.sh — SessionStart hook: inject memory into Claude context
# Everything printed to stdout is injected into Claude's context

set -euo pipefail

INPUT=$(cat)

CWD=$(echo "$INPUT" | jq -r '.cwd')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
SOURCE=$(echo "$INPUT" | jq -r '.source // "unknown"')

echo "[SessionStart] session=$SESSION_ID source=$SOURCE"
PROJECT_ID="${CWD//\//-}"

# MEMORY_HOME allows test isolation; defaults to ~/.memory
MEMORY_ROOT="${MEMORY_HOME:-$HOME/.memory}"
PROJECT_DIR="$MEMORY_ROOT/projects/$PROJECT_ID"
SESSION_DIR="$PROJECT_DIR/$SESSION_ID"

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Ensure project dir exists
mkdir -p "$PROJECT_DIR"

# Step: archive pending topics from previous sessions (skip during compact to reduce cognitive load)
# Runs as background process — self-starts LLM, does not block session start or occupy Agent context
if [ "$SOURCE" != "compact" ]; then
  "$PLUGIN_ROOT/scripts/archive-pending.sh" "$PROJECT_DIR" "$SESSION_ID" "$PLUGIN_ROOT" &>/dev/null &
fi

# Push layer 1: inject REMEMBER.md (global + project)
GLOBAL_REMEMBER="$MEMORY_ROOT/REMEMBER.md"
PROJECT_REMEMBER="$PROJECT_DIR/REMEMBER.md"

if [ -f "$GLOBAL_REMEMBER" ]; then
  echo "=== Things You Should Remember (Global) ==="
  cat "$GLOBAL_REMEMBER"
  echo ""
fi

if [ -f "$PROJECT_REMEMBER" ]; then
  echo "=== Things You Should Remember (This Project) ==="
  cat "$PROJECT_REMEMBER"
  echo ""
fi

# Legacy: inject preferences.md if it exists (will be migrated to REMEMBER.md)
PREFERENCES="$MEMORY_ROOT/global/preferences.md"
if [ -f "$PREFERENCES" ]; then
  echo "=== User Preferences & Constraints (auto-injected, please follow) ==="
  cat "$PREFERENCES"
  echo ""
fi

# Push layer 2: list topic files grouped by session, sorted by recency (max 20 sessions)
if [ -d "$PROJECT_DIR" ]; then
  # For each session dir: get newest file mtime (epoch), date, topics in seq order
  TOPIC_HISTORY=$(
    for session_dir in "$PROJECT_DIR"/*/; do
      [ ! -d "$session_dir" ] && continue
      sid=$(basename "$session_dir")
      short=$(echo "$sid" | cut -c1-8)

      # List topic files (exclude hidden), sorted by name (= seq order)
      topics=$(find "$session_dir" -maxdepth 1 -name "*.md" -not -name ".*" 2>/dev/null | sed 's|.*/||; s|\.md$||' | sort)
      [ -z "$topics" ] && continue

      # Get newest file mtime as epoch (macOS stat -f, Linux stat -c fallback)
      newest=$(find "$session_dir" -maxdepth 1 -name "*.md" -not -name ".*" -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)
      [ -z "$newest" ] && newest=$(find "$session_dir" -maxdepth 1 -name "*.md" -not -name ".*" -exec stat -c '%Y' {} + 2>/dev/null | sort -rn | head -1)
      [ -z "$newest" ] && continue

      # Format date from epoch
      dt=$(date -r "$newest" "+%m-%d %H:%M" 2>/dev/null || date -d "@$newest" "+%m-%d %H:%M" 2>/dev/null)

      # Output: epoch|display_line (epoch for sorting, stripped later)
      echo "${newest}|${short} (${dt}): $(echo "$topics" | paste -sd',' - | sed 's/,/, /g')"
    done | sort -rn | head -20 | cut -d'|' -f2-
  )
  if [ -n "$TOPIC_HISTORY" ]; then
    echo "=== Topic History for This Project (recent 20 sessions) ==="
    echo "$TOPIC_HISTORY"
    echo ""
  fi
fi

# Pull layer: tell Claude where to find memory files and scripts
echo "Your persistent memory is stored at $PROJECT_DIR (session directories with topic files)."
echo "If topic history files are listed above, check the user's first message to decide whether to cat any of them to restore context."
echo ""
echo "Plugin scripts path: $PLUGIN_ROOT/scripts"
echo ""

# Push layer 3: inject topic tracking state
STATE_FILE="$SESSION_DIR/.current_topic"
if [ -f "$STATE_FILE" ]; then
  CURRENT_TOPIC=$(cat "$STATE_FILE")
else
  CURRENT_TOPIC="(none — use your first topic slug in the tag, the Stop hook will register it)"
fi
cat <<EOF

=== Topic Tag Rule ===
At the START of every reply, output a topic tag in this exact format:
› \`your-topic-slug\`
The slug should be 2-4 words, lowercase, hyphen-separated, describing the current topic.
If the topic hasn't changed, repeat the same slug. If it has, use the new slug.
This tag is machine-read by the Stop hook. Always include it.

Current topic: $CURRENT_TOPIC
Topic archival is automatic — the Stop hook detects topic changes from your tag and guides you through archival. You do not need to call any skill manually.
EOF

# Feature A: Compact context recovery — extract + cold-reader summary via claude -p
if [ "$SOURCE" = "compact" ] && [ -f "$STATE_FILE" ]; then
  CURRENT_SLUG=$(cat "$STATE_FILE")
  mkdir -p "$SESSION_DIR"

  # Create .compacted marker — signals archive-pending to skip this session
  touch "$SESSION_DIR/.compacted"

  JSONL_PATH="$HOME/.claude/projects/$PROJECT_ID/$SESSION_ID.jsonl"
  if [ -f "$JSONL_PATH" ] && [ -n "$CURRENT_SLUG" ]; then
    EXTRACT_SCRIPT="$PLUGIN_ROOT/scripts/extract-topic.js"
    SUMMARY_TEMPLATE=$(cat "$PLUGIN_ROOT/scripts/topic-tmpl.md")

    # Extract conversation for current topic
    EXTRACTED=$(node "$EXTRACT_SCRIPT" "$JSONL_PATH" "$CURRENT_SLUG" 2>/dev/null) || true

    if [ -n "$EXTRACTED" ]; then
      # Cold-reader summarization via claude -p (blocks session start)
      ARCHIVE_CWD=$(mktemp -d)
      RECOVERY=$(unset CLAUDECODE; cd "$ARCHIVE_CWD" && claude -p --model sonnet --no-session-persistence "You are summarizing a conversation extract for context recovery after compaction. Output the following TWO parts:

PART 1 — Structured summary (section headings in English, content in user's language, skip empty sections):

${SUMMARY_TEMPLATE}

PART 2 — Copy the last 2 User/Assistant exchanges verbatim from the conversation. Preserve the original language exactly. Use the heading format:
### Last exchanges
## User
...
## Assistant
...
## User
...
## Assistant
...

Rules: State facts only. No AI filler language.

--- CONVERSATION ---
${EXTRACTED}
--- END ---" 2>/dev/null) || true
      rm -rf "$ARCHIVE_CWD"

      # Strip any LLM filler before the first ## heading
      RECOVERY=$(echo "$RECOVERY" | sed -n '/^## /,$p')

      if [ -n "$RECOVERY" ]; then
        cat <<RECOVERY_EOF

=== Context Recovery (compaction detected) ===
Your context was just compacted. Below is a summary and recent exchanges for topic: $CURRENT_SLUG

$RECOVERY
RECOVERY_EOF
      fi
    fi
  fi
fi
