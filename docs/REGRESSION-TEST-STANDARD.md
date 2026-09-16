# claude-mem Regression Acceptance Standard (7 Hooks + Memory Recall + Summarization)

> This file defines the **unified regression acceptance baseline** for the four-agent claude-mem integration.
> After deploying or fixing any machine/agent, run the regression per this standard; it is "usable" only when everything passes.
> Applies to: local agents (opencode / CodeBuddy / Hermes) and the cc-connect channel (pi) — both channels share the same standard.

---

## 1. Acceptance overview

The regression covers **3 capabilities**, all mandatory:

| Capability | Description | Pass criterion |
|---|---|---|
| **1. Auto-capture** | The 7 hook lifecycle events are captured and delivered to the worker | Persisted records for every fired hook event are present |
| **2. Summarization** | The worker generates a session summary via the LLM | The `session_summaries` table has a new, non-empty row |
| **3. Memory recall** | Historical content can be retrieved from the memory store | The search API returns matching observations |

**The persisted triplet** (the tables to inspect during acceptance):
- `user_prompts` — user questions (written by init)
- `observations` — intelligent-compression summaries (written by observation)
- `session_summaries` — session summaries (written by summarize)

---

## 2. The 7 hook events (Claude Code lifecycle)

Claude-Code-style hooks have 7 core lifecycle events (plus 2 optional extensions: SubagentStop / PreCompact):

| # | Hook event | When it fires | What claude-mem should do | Persisted to |
|---|---|---|---|---|
| 1 | **SessionStart** | session begins | create the session (init) | first user_prompts row |
| 2 | **UserPromptSubmit** | user submits a prompt | record the user message (observation, tool=user_prompt) | user_prompts / observations |
| 3 | **PreToolUse** | before a tool call | (optional) record tool inputs | observations |
| 4 | **PostToolUse** | after a tool call | record the tool call (tool_name + in/out) | observations |
| 5 | **Notification** | session notification | (optional) record the notification | observations |
| 6 | **Stop** | session ends | trigger summarization | session_summaries |
| 7 | **SessionEnd** | session fully ends | fallback summarization | session_summaries |

> Extensions: SubagentStop (sub-agent ends), PreCompact (before compaction) — optionally supported, not mandatory for regression.

### Hook coverage per agent

| Agent | Integration | Events covered |
|---|---|---|
| **opencode** | native plugin | chat.message (user), tool.execute.after (tool), experimental.text.complete / message.part.updated (assistant streaming), message.updated (role), session.idle / experimental.session.compacting (summary), session.deleted (cleanup) |
| **CodeBuddy** | hook (settings.json) | SessionStart / UserPromptSubmit / PostToolUse / Stop |
| **pi** | native extension | session_start -> init, user messages/tools/replies -> observation, session end -> summarize |
| **Hermes** | gateway/run_turn.py | asynchronous capture after a turn ends (init + observation + summarize) |

---

## 3. Regression steps (run per agent)

### 3.1 Trigger one complete turn

Send a real message using the agent's trigger method:
```bash
# opencode (with a tool call — closer to real usage)
opencode run "list the /tmp directory, then reply: regression done"

# codebuddy / any hook-style agent (simulate the lifecycle)
echo '{"hook_event_name":"UserPromptSubmit","session_id":"test-<ts>","cwd":"/home/yourname","prompt":"regression test message"}' | claude-mem-worker.sh hook codebuddy
# then send Stop to trigger summarization:
echo '{"hook_event_name":"Stop","session_id":"test-<ts>","cwd":"/home/yourname"}' | claude-mem-worker.sh hook codebuddy

# pi
pi -p "reply with only: regression test"

# Hermes: the next conversation turn in the current gateway session triggers it automatically
```

### 3.2 Wait for worker LLM processing (8-20 seconds)

### 3.3 Inspect the persisted triplet in the database

```bash
DB=~/.claude-mem/claude-mem.db
# latest observations (the summary of the test just run should appear)
sqlite3 "$DB" "SELECT datetime(created_at_epoch/1000,'unixepoch','+8 hours'), project, substr(narrative,1,40) FROM observations ORDER BY created_at_epoch DESC LIMIT 3;"
# latest summaries (a session summary should be generated)
sqlite3 "$DB" "SELECT datetime(created_at_epoch/1000,'unixepoch','+8 hours'), project, substr(request,1,40) FROM session_summaries ORDER BY created_at_epoch DESC LIMIT 3;"
```

### 3.4 Pass criteria (all must hold)

| Item | Criterion |
|---|---|
| user_prompt persisted | A row for the test session exists, with the real message text (not `[media prompt]`) |
| observation persisted | A summary for the test session exists (narrative non-empty) |
| summary persisted | A session summary for the test session exists (request non-empty) |
| `[media prompt]` increment | 0 (no empty init after the fix) |

---

## 4. Memory recall acceptance

```bash
# Retrieve historical memory via the worker search API
curl -s "http://127.0.0.1:37701/api/search/observations?query=<keyword>&limit=3"
# expected: JSON content[] containing matching observation titles/bodies
```

**Criterion:** passes when observation records related to the keyword are retrieved (including content from historical sessions).

---

## 5. Quick full acceptance (one command to check all agents' activity)

```bash
DB=~/.claude-mem/claude-mem.db
NOW=$(python3 -c "import time; print(int(time.time()*1000))")
echo "=== capture activity in the last 30 minutes ==="
sqlite3 "$DB" "SELECT project, count(*) FROM observations WHERE created_at_epoch > $((NOW-1800000)) GROUP BY project ORDER BY count(*) DESC;"
echo "=== summary activity in the last 1 hour ==="
sqlite3 "$DB" "SELECT project, count(*) FROM session_summaries WHERE created_at_epoch > $((NOW-3600000)) GROUP BY project ORDER BY count(*) DESC;"
echo "=== memory recall ==="
curl -s "http://127.0.0.1:37701/api/search/observations?query=test&limit=2"
echo "=== [media prompt] increment (should be 0) ==="
sqlite3 "$DB" "SELECT count(*) FROM user_prompts WHERE prompt_text LIKE '%[media prompt]%' AND created_at_epoch > $((NOW-86400000));"
```

---

## 6. Regression record template

| Item | Value |
|---|---|
| Regression date | YYYY-MM-DD |
| Environment | local / cc-connect / new machine |
| Worker version | v13.18.0 |
| Worker health | degraded=false, lastInteraction non-null |
| opencode | up/obs/summary timestamps + pass |
| CodeBuddy | up/obs/summary timestamps + pass |
| pi (pi-claude-mem) | up/obs/summary timestamps + pass |
| Hermes | up/obs/summary timestamps + pass |
| Memory recall | search keyword + hit count |
| `[media prompt]` increment | 0 |
| **Conclusion** | all passed / failed items |

---

## 7. Pitfall cheat sheet (easy misjudgments during regression)

1. **Hook-style agents (codebuddy/hermes) land observations under `project='unknown'`** — filtering by project name looks like an empty result; query by created_at descending instead.
2. **memory_session_id can change** — during summarize the worker may assign the session a new id, so joining on session_db_id may miss rows; use the final memory_session_id or content matching.
3. **A single `opencode run` occasionally lacks a summary** — the `session.idle` event fires inconsistently in that edge case; interactive/cc-connect sessions summarize reliably. Judge against real usage scenarios.
4. **Three worker health checks** — `dependencies.degraded` (missing claude CLI?), `ai.lastInteraction` (null = LLM never called), `ai.provider` (which pipeline).
5. **`[media prompt]` does NOT mean data is healthy** — it signals some agent sent an empty init; it is a defect signal, not normal behavior.
