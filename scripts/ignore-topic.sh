#!/usr/bin/env bash
# ignore-topic.sh — Manage .ignore rules for topic archival
#
# Usage:
#   ignore-topic.sh add    <scope> <pattern> [pattern2 ...]
#   ignore-topic.sh remove <scope> <pattern>
#   ignore-topic.sh list   [project_dir]
#
# scope: "global" or path to project dir (e.g., ~/.memory/projects/-Users-hata-my-app)

set -euo pipefail

ACTION="${1:-}"
MEMORY_ROOT="${MEMORY_HOME:-$HOME/.memory}"

resolve_ignore_file() {
  local scope="$1"
  if [ "$scope" = "global" ]; then
    echo "$MEMORY_ROOT/.ignore"
  else
    echo "$scope/.ignore"
  fi
}

cmd_add() {
  local scope="$1"
  shift
  local ignore_file
  ignore_file=$(resolve_ignore_file "$scope")
  mkdir -p "$(dirname "$ignore_file")"

  for pattern in "$@"; do
    # Check for duplicate
    if [ -f "$ignore_file" ] && grep -qFx "$pattern" "$ignore_file"; then
      echo "Already exists: $pattern (in $ignore_file)"
    else
      echo "$pattern" >> "$ignore_file"
      echo "Added: $pattern (to $ignore_file)"
    fi
  done
}

cmd_remove() {
  local scope="$1"
  local pattern="$2"
  local ignore_file
  ignore_file=$(resolve_ignore_file "$scope")

  if [ ! -f "$ignore_file" ]; then
    echo "Not found: no .ignore file at $ignore_file"
    return 1
  fi

  if grep -qFx "$pattern" "$ignore_file"; then
    # Remove exact line match
    local tmp="${ignore_file}.tmp"
    grep -vFx "$pattern" "$ignore_file" > "$tmp" || true
    mv "$tmp" "$ignore_file"
    # Remove file if empty
    if [ ! -s "$ignore_file" ]; then
      rm -f "$ignore_file"
    fi
    echo "Removed: $pattern (from $ignore_file)"
  else
    echo "Not found: $pattern (in $ignore_file)"
    return 1
  fi
}

cmd_list() {
  local project_dir="${1:-}"
  local found=false

  local global_file="$MEMORY_ROOT/.ignore"
  if [ -f "$global_file" ]; then
    echo "Global ($global_file):"
    while IFS= read -r line || [ -n "$line" ]; do
      [[ -z "$line" || "$line" == \#* ]] && continue
      echo "  $line"
      found=true
    done < "$global_file"
  fi

  if [ -n "$project_dir" ] && [ -f "$project_dir/.ignore" ]; then
    echo "Project ($project_dir/.ignore):"
    while IFS= read -r line || [ -n "$line" ]; do
      [[ -z "$line" || "$line" == \#* ]] && continue
      echo "  $line"
      found=true
    done < "$project_dir/.ignore"
  fi

  if [ "$found" = false ]; then
    echo "No ignore rules configured."
  fi
}

case "$ACTION" in
  add)
    [ $# -lt 3 ] && { echo "Usage: ignore-topic.sh add <scope> <pattern> [pattern2 ...]" >&2; exit 1; }
    SCOPE="$2"
    shift 2
    cmd_add "$SCOPE" "$@"
    ;;
  remove)
    [ $# -lt 3 ] && { echo "Usage: ignore-topic.sh remove <scope> <pattern>" >&2; exit 1; }
    cmd_remove "$2" "$3"
    ;;
  list)
    cmd_list "${2:-}"
    ;;
  *)
    echo "Usage: ignore-topic.sh {add|remove|list} ..." >&2
    exit 1
    ;;
esac
