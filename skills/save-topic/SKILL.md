---
name: save-topic
description: Use when the user wants to save or checkpoint topic progress, persist current discussion state, or save all topics before ending a session.
---

# save-topic

## Overview

Saves a structured summary of a topic to a persistent file. Supports saving the current topic, a specific topic by slug, or multiple topics at once.

## Instructions

### Preparation

1. Get the **session ID** from the SessionStart injection in your context:
   `[SessionStart] session=SESSION_ID source=...`

2. Get the **plugin scripts path** from the SessionStart injection:
   `Plugin scripts path: /path/to/scripts`

3. Determine **which topics** to save:
   - "save topic" / "checkpoint" → current topic only
   - "save topic X" → the specified topic slug
   - "save all topics" → all topics in this session

### Saving the current topic

1. Get the **current topic slug** from your topic tag (the `› \`slug\`` you've been outputting).

2. Write a structured summary using the format below (section headings in English, content in user's language, skip empty sections):

```
## Status
What was done, key progress.

## Decisions
What was chosen, why, what was rejected.

## Failures
What was tried, why it failed, the fix or workaround.

## Next Steps
What to do next. Be specific and actionable.
```

3. Run:

```bash
bash "<plugin_scripts_path>/save-topic.sh" "<slug>" "<session_id>" "<summary>"
```

### Saving a non-current topic

For topics you are NOT currently discussing, your LLM context is likely incomplete. Use the `--cold` flag to force cold-read from JSONL:

```bash
bash "<plugin_scripts_path>/save-topic.sh" --cold "<slug>" "<session_id>" ""
```

The script will extract the conversation from JSONL and generate a summary via `claude -p`. The third argument (summary) is ignored when `--cold` succeeds.

### Saving multiple topics

1. Get all topic slugs by running extract-topic.js (same as list-topics skill step 4):
   `node "<plugin_scripts_path>/extract-topic.js" "$HOME/.claude/projects/<project_id>/<session_id>.jsonl" __all__`
   Filter out `__untagged__` from the output.
2. Save the **current topic** using the normal path (LLM writes summary).
3. Save each **non-current topic** using the `--cold` flag.

## Rules

- State facts only. No AI filler language.
- If an existing file for this slug exists, it will be overwritten with the new summary.
- This does NOT change the current topic — you continue with the same topic tag after saving.
- The summary should cover the entire topic from the start, not just recent progress.
- For non-current topics, always use `--cold` — do not attempt to write summaries from degraded LLM memory.
