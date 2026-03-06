#!/usr/bin/env bash
# dev-register.sh — Register hooks manually for development (bypass plugin system)
# Writes hook entries into the project's .claude/settings.json
#
# Usage: dev-register.sh [project_dir]
#   project_dir: target project directory (default: current directory)
#
# This creates .claude/settings.json with hooks pointing to the SOURCE repo,
# not the plugin cache. Changes to hook scripts take effect immediately.

set -euo pipefail

PROJECT_DIR="${1:-.}"
PROJECT_DIR=$(cd "$PROJECT_DIR" && pwd)

# Resolve this script's repo root
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SETTINGS_DIR="$PROJECT_DIR/.claude"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"

mkdir -p "$SETTINGS_DIR"

# If settings.json exists, check for existing hooks
if [ -f "$SETTINGS_FILE" ]; then
  EXISTING_HOOKS=$(jq '.hooks // empty' "$SETTINGS_FILE" 2>/dev/null)
  if [ -n "$EXISTING_HOOKS" ] && [ "$EXISTING_HOOKS" != "null" ]; then
    echo "WARNING: $SETTINGS_FILE already has hooks:" >&2
    echo "$EXISTING_HOOKS" | jq '.' >&2
    echo "" >&2
    read -r -p "Overwrite hooks? [y/N] " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
      echo "Aborted."
      exit 0
    fi
  fi
  # Merge: preserve other keys, overwrite hooks
  jq --arg ss "$REPO_ROOT/hooks/session-start.sh" \
     --arg stop "$REPO_ROOT/hooks/stop.sh" \
     '.hooks = {
        "SessionStart": [{"matcher": "startup|resume|clear|compact", "hooks": [{"type": "command", "command": $ss}]}],
        "Stop": [{"hooks": [{"type": "command", "command": $stop}]}]
      }' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
else
  cat > "$SETTINGS_FILE" <<EOF
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "command", "command": "$REPO_ROOT/hooks/session-start.sh" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "$REPO_ROOT/hooks/stop.sh" }]
      }
    ]
  }
}
EOF
fi

echo "Registered hooks in $SETTINGS_FILE"
echo "  SessionStart → $REPO_ROOT/hooks/session-start.sh"
echo "  Stop         → $REPO_ROOT/hooks/stop.sh"

# Auto-symlink all skills from the repo
SKILLS_DIR="$SETTINGS_DIR/skills"
mkdir -p "$SKILLS_DIR"
for skill_dir in "$REPO_ROOT"/skills/*/; do
  [ ! -d "$skill_dir" ] && continue
  skill_name=$(basename "$skill_dir")
  target="$SKILLS_DIR/$skill_name"
  if [ -L "$target" ] || [ -d "$target" ]; then
    echo "  Skill: $skill_name (already exists, skipped)"
  else
    ln -sf "$skill_dir" "$target"
    echo "  Skill: $skill_name → $skill_dir"
  fi
done
