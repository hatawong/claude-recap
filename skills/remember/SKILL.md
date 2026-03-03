---
name: remember
description: Use when the user wants to persistently remember something across sessions (e.g., "always use bun", "never auto-commit", "my name is Alex"). Also use when you detect a clear user preference or constraint worth persisting.
---

# remember

## Overview

Saves a user preference, constraint, or fact to REMEMBER.md so it persists across sessions. The user chooses scope (global or project).

## When to Use

- User explicitly says "remember...", "always...", "never...", "don't forget..."
- User states a clear preference or constraint worth persisting (e.g., "I use bun not npm")
- User provides identity or context info they'd want every session to know

## Instructions

1. Distill what the user wants to remember into **one concise line** (imperative form, no filler).
   - Good: "Use bun instead of npm for all package management"
   - Bad: "The user mentioned they prefer bun over npm and would like us to always use it"

2. Ask the user which scope using AskUserQuestion:

```
Which scope should this apply to?
- Global: applies to all projects
- Project: applies only to this project
```

3. Get the **plugin scripts path** from the SessionStart injection in your context:
   `Plugin scripts path: /path/to/scripts`

4. Run the remember script:

```bash
bash "<plugin_scripts_path>/remember.sh" "<scope>" "<content>"
```

Where:
- `plugin_scripts_path`: the path from SessionStart injection
- `scope`: `global` or `project`
- `content`: the distilled one-liner (quote it properly for shell)

## Rules

- One entry per invocation — don't batch multiple items
- Distill to a clear imperative statement, not a description of what happened
- If the user's intent is ambiguous, ask for clarification before writing
- Do NOT remember session-specific or temporary information (e.g., "I'm debugging auth today")

## Examples

| User says | Distilled entry |
|---|---|
| "Remember I always use bun" | `Use bun instead of npm for package management` |
| "Never auto-commit without asking" | `Never auto-commit; always ask before committing` |
| "My name is Alex" | `User's name is Alex` |
| "For this project, always run tests with --verbose" | `Run tests with --verbose flag` (project scope) |
