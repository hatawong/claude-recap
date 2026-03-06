#!/usr/bin/env bash
# dev-unregister.sh — Remove manually registered hooks (undo dev-register.sh)
#
# Usage: dev-unregister.sh [project_dir]
#   project_dir: target project directory (default: current directory)
#
# Removes hooks from .claude/settings.json. Does NOT delete the file
# (it may contain other settings like permissions).

set -euo pipefail

PROJECT_DIR="${1:-.}"
PROJECT_DIR=$(cd "$PROJECT_DIR" && pwd)

SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "No $SETTINGS_FILE found, nothing to unregister."
  exit 0
fi

# Check if hooks exist
EXISTING_HOOKS=$(jq '.hooks // empty' "$SETTINGS_FILE" 2>/dev/null)
if [ -z "$EXISTING_HOOKS" ] || [ "$EXISTING_HOOKS" = "null" ]; then
  echo "No hooks in $SETTINGS_FILE, nothing to unregister."
  exit 0
fi

# Remove hooks key, preserve other settings
jq 'del(.hooks)' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"

# If file is now just {}, delete it
REMAINING=$(jq 'keys | length' "$SETTINGS_FILE" 2>/dev/null)
if [ "$REMAINING" = "0" ]; then
  rm "$SETTINGS_FILE"
  echo "Removed $SETTINGS_FILE (was empty after removing hooks)"
else
  echo "Removed hooks from $SETTINGS_FILE (other settings preserved)"
fi

# Remove skill symlinks that point to this repo
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="$PROJECT_DIR/.claude/skills"
if [ -d "$SKILLS_DIR" ]; then
  REMOVED=0
  for target in "$SKILLS_DIR"/*; do
    [ ! -L "$target" ] && continue
    # Only remove symlinks pointing into our repo
    link_dest=$(readlink "$target" 2>/dev/null || true)
    if [[ "$link_dest" == "$REPO_ROOT/"* ]]; then
      rm "$target"
      echo "  Removed skill: $(basename "$target")"
      REMOVED=$((REMOVED + 1))
    fi
  done
  # Remove skills dir if empty
  if [ -d "$SKILLS_DIR" ] && [ -z "$(ls -A "$SKILLS_DIR" 2>/dev/null)" ]; then
    rmdir "$SKILLS_DIR"
  fi
  if [ "$REMOVED" -gt 0 ]; then
    echo "Removed $REMOVED skill symlink(s)"
  fi
fi

echo "Done. Hooks unregistered for $PROJECT_DIR"
