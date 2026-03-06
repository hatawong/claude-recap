---
name: ignore-topic
description: Use when the user wants to ignore, skip, or exclude specific topics from being archived. Triggers on "ignore topic", "don't archive", "skip topic", "stop remembering", "list ignored topics", "remove ignore rule".
---

# ignore-topic

Manage `.ignore` rules — glob patterns that prevent matching topic slugs from being archived. Topics still get tagged but archival is skipped (no LLM summary call, no file written).

## Step 1: Determine operation

Parse the user's message for operation (add/remove/list) and patterns. If clear, skip to Step 2.

Otherwise, ask using AskUserQuestion:

```
What would you like to do?
- Add: Add ignore patterns (topics matching these will not be archived)
- Remove: Remove an existing ignore pattern
- List: Show all current ignore rules
```

## Step 2: Execute

**add:**

1. If no patterns provided, ask for patterns (space-separated, glob supported: `*`, `?`, `[...]`).
2. Ask scope via AskUserQuestion:
   ```
   Which scope?
   - Global: applies to all projects (~/.memory/.ignore)
   - Project: applies only to this project
   ```
3. Run:
   ```bash
   bash "<plugin_scripts_path>/ignore-topic.sh" add "<scope>" <pattern1> [pattern2 ...]
   ```
   `<scope>`: `global` or the project dir path from SessionStart context.

**remove:**

1. If no pattern provided, ask which pattern to remove.
2. Ask scope (global or project).
3. Run:
   ```bash
   bash "<plugin_scripts_path>/ignore-topic.sh" remove "<scope>" "<pattern>"
   ```

**list:**

```bash
bash "<plugin_scripts_path>/ignore-topic.sh" list "<project_dir>"
```

## Path resolution

- `<plugin_scripts_path>`: from SessionStart injection `Plugin scripts path: ...`
- `<project_dir>`: from SessionStart injection `Your persistent memory is stored at <project_dir>`

## Examples

| User says | Operation | Scope question? |
|---|---|---|
| `/ignore-topic add git-* lint-fix` | add `git-*` and `lint-fix` | Yes |
| `/ignore-topic` | Ask all | Yes |
| `/ignore-topic list` | list | No |
| "don't archive run-tests topics" | add `run-tests` | Yes |
| `/ignore-topic remove git-*` | remove `git-*` | Yes |
