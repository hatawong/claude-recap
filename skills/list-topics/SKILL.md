---
name: list-topics
description: Use when the user asks about topics discussed in the current session, wants to see a topic list, or asks what has been talked about.
---

# list-topics

## Overview

Lists all topic slugs found in the current session's JSONL history.

## Instructions

1. Get the **session ID** from the SessionStart injection in your context:
   `[SessionStart] session=SESSION_ID source=...`

2. Get the **plugin scripts path** from the SessionStart injection:
   `Plugin scripts path: /path/to/scripts`

3. Get the **project ID** from the SessionStart injection:
   `Your persistent memory is stored at: $HOME/.memory/projects/PROJECT_ID/`
   Extract the PROJECT_ID segment (e.g. `-Users-alex-my-app`).

4. Run extract-topic.js with `__all__` mode:

```bash
node "<plugin_scripts_path>/extract-topic.js" "$HOME/.claude/projects/<project_id>/<session_id>.jsonl" __all__
```

5. Filter out `__untagged__` from the output, then present using this exact format:

```
Session Topics:
1. **topic-slug-a**
2. **topic-slug-b**
3. **topic-slug-c**

Current: **topic-slug-c**
```

## Rules

- If JSONL file doesn't exist or no topics found after filtering, tell the user no topics exist yet.
- Current topic is from your topic tag (the `› \`slug\`` you've been outputting).
