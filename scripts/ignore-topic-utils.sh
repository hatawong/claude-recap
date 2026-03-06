#!/usr/bin/env bash
# ignore-topic-utils.sh — Check if a topic slug matches .ignore patterns
# Source this file, then call: topic_is_ignored <slug> <memory_root> <project_dir>
#
# .ignore file format (same as .gitignore):
#   - Lines starting with # are comments
#   - Empty lines are ignored
#   - Supports glob patterns: * ? [...]
#   - Example: git-*    (matches git-rebase, git-commit, etc.)
#   - Example: lint-fix  (exact match)

topic_is_ignored() {
  local slug="$1"
  local memory_root="$2"
  local project_dir="$3"

  local ignore_files=()
  # Global ignore
  [ -f "$memory_root/.ignore" ] && ignore_files+=("$memory_root/.ignore")
  # Project-level ignore
  [ -f "$project_dir/.ignore" ] && ignore_files+=("$project_dir/.ignore")

  [ ${#ignore_files[@]} -eq 0 ] && return 1

  for file in "${ignore_files[@]}"; do
    while IFS= read -r pattern || [ -n "$pattern" ]; do
      # Skip empty lines and comments
      [[ -z "$pattern" || "$pattern" == \#* ]] && continue
      # Trim whitespace
      pattern="${pattern#"${pattern%%[![:space:]]*}"}"
      pattern="${pattern%"${pattern##*[![:space:]]}"}"
      [ -z "$pattern" ] && continue
      # Bash glob match (supports * ? [...])
      # shellcheck disable=SC2254
      if [[ "$slug" == $pattern ]]; then
        return 0
      fi
    done < "$file"
  done

  return 1
}
