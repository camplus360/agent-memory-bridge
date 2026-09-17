---
name: mem-search
description: Search claude-mem's persistent cross-session memory database. Use when user asks "did we already solve this?", "how did we do X last time?", or needs work from previous sessions.
---

<!-- SPDX-License-Identifier: AGPL-3.0-or-later. Derivative of claude-mem / pi-agent-memory; see agents/pi/LICENSE and agents/pi/NOTICE. -->

# Memory Search (claude-mem)

Search past work across pi-coding-agent sessions. The `memory_recall` tool is
registered automatically by the **pi-claude-mem** extension, which forwards the
query to the local claude-mem worker.

## When to Use

Use when users ask about PREVIOUS sessions (not the current conversation):

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"
- "What do you remember about the auth refactor?"

## Usage

The `memory_recall` tool is available in your tool list. Call it with a natural
language query:

```text
memory_recall(query="authentication middleware refactor", limit=10)
```

**Parameters:**

- `query` (string, required) — Natural language search term
- `limit` (number, optional) — Max results, default 5

## Tips

- Search broad first, then narrow: "auth" before "JWT token rotation in middleware"
- The worker searches across ALL engines (Claude Code, OpenClaw, other pi-agents) for the same project
- Results include observation summaries, session titles, and timestamps
- If you need more detail, ask follow-up questions using specific terms from the initial results

## How It Works

`memory_recall` calls the claude-mem worker's search API, which uses hybrid search:

1. **FTS5** — full-text keyword matching on observation content
2. **Chroma** — vector similarity search for semantic meaning

Results are merged and ranked by relevance. The worker backend is a separate,
independently run program; this extension is only its HTTP client.
