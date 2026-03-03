#!/usr/bin/env bash
# remember.sh — Write a memory entry to REMEMBER.md (global or project scope)
#
# Usage: remember.sh <scope> <content>
#   scope: "global" or "project"
#   content: the thing to remember (one line)

set -euo pipefail

SCOPE="$1"
CONTENT="$2"

# CLAUDE_CWD: test-only override; in production pwd -P resolves symlinks (e.g. /tmp → /private/tmp)
# to match Claude Code's resolved CWD in JSON input (used by hooks for PROJECT_ID)
CWD="${CLAUDE_CWD:-$(pwd -P)}"
PROJECT_ID="${CWD//\//-}"
MEMORY_ROOT="${MEMORY_HOME:-$HOME/.memory}"

if [ "$SCOPE" = "global" ]; then
  TARGET="$MEMORY_ROOT/REMEMBER.md"
elif [ "$SCOPE" = "project" ]; then
  TARGET="$MEMORY_ROOT/projects/$PROJECT_ID/REMEMBER.md"
else
  echo "Error: scope must be 'global' or 'project', got '$SCOPE'" >&2
  exit 1
fi

# Create directory and file if needed
mkdir -p "$(dirname "$TARGET")"
if [ ! -f "$TARGET" ]; then
  if [ "$SCOPE" = "global" ]; then
    echo "# REMEMBER (Global)" > "$TARGET"
  else
    echo "# REMEMBER (Project)" > "$TARGET"
  fi
  echo "" >> "$TARGET"
fi

# Append the new entry
echo "- $CONTENT" >> "$TARGET"
echo "Remembered ($SCOPE): $CONTENT"
echo "Written to: $TARGET"
