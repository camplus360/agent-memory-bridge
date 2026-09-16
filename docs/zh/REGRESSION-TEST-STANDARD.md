# claude-mem 回测验收标准（7 Hooks + 记忆召回 + 总结）

> 本文件定义 claude-mem 四 agent 接入的**统一回测验收基线**。
> 任何机器/agent 部署或修复后，按下述标准回测，全部通过才算"可用"。
> 适用于：本机 agent（opencode / CodeBuddy / Hermes）与 cc-connect 通道（pi），两通道同标准。

---

## 一、验收总纲

回测覆盖 **3 大能力**，缺一不可：

| 能力 | 说明 | 验收判定 |
|---|---|---|
| **① 自动捕获** | 7 个 hook 事件生命周期能被捕获并投递到 worker | 各 hook 事件触发的落库记录齐全 |
| **② 总结** | worker 用 LLM 生成会话总结（summarize） | `session_summaries` 表有新增且非空 |
| **③ 记忆召回** | 能从记忆库检索到历史内容 | search API 返回匹配观测 |

**三件套落库表**（验收查库对象）：
- `user_prompts` —— 用户提问（init 写入）
- `observations` —— 智能压缩摘要（observation 写入）
- `session_summaries` —— 会话总结（summarize 写入）

---

## 二、7 个 Hook 事件（Claude Code 生命周期）

Claude Code 系 hook 的生命周期事件共 7 个核心（另含 2 个扩展：SubagentStop / PreCompact，可选）：

| # | Hook 事件 | 触发时机 | claude-mem 应执行 | 落库 |
|---|---|---|---|---|
| 1 | **SessionStart** | 会话开始 | 建会话（init） | user_prompts 首次 |
| 2 | **UserPromptSubmit** | 用户提交提问 | 记录用户消息（observation，tool=user_prompt） | user_prompts / observations |
| 3 | **PreToolUse** | 工具调用前 | （可选）记录工具入参 | observations |
| 4 | **PostToolUse** | 工具调用后 | 记录工具调用（tool_name + in/out） | observations |
| 5 | **Notification** | 会话通知 | （可选）记录通知 | observations |
| 6 | **Stop** | 会话结束 | 触发总结（summarize） | session_summaries |
| 7 | **SessionEnd** | 会话彻底结束 | 兜底总结（summarize） | session_summaries |

> 扩展：SubagentStop（子代理结束）、PreCompact（压缩前）—— 可选支持，回测不强制。

### 各 agent 的 hook 覆盖映射

| Agent | 接入方式 | 覆盖事件 |
|---|---|---|
| **opencode** | 原生插件 | chat.message（用户）、tool.execute.after（工具）、experimental.text.complete / message.part.updated（assistant 流式）、message.updated（role）、session.idle / experimental.session.compacting（总结）、session.deleted（清理） |
| **CodeBuddy** | hook（settings.json） | SessionStart / UserPromptSubmit / PostToolUse / Stop |
| **pi** | 原生扩展 | session_start → init、用户消息/工具/回复 → observation、会话结束 → summarize |
| **Hermes** | gateway/run_turn.py | 回合结束异步捕获（init + observation + summarize） |

---

## 三、回测步骤（每 agent 执行）

### 3.1 触发一次完整 turn

按 agent 触发方式发一条真实消息：
```bash
# opencode（含工具调用，更贴近真实）
opencode run "请列出 /tmp 目录，然后回复：回测完成"

# codebuddy / 任意 hook 系（模拟生命周期）
echo '{"hook_event_name":"UserPromptSubmit","session_id":"test-<ts>","cwd":"/home/yourname","prompt":"回测测试消息"}' | claude-mem-worker.sh hook codebuddy
# 再补 Stop 触发总结：
echo '{"hook_event_name":"Stop","session_id":"test-<ts>","cwd":"/home/yourname"}' | claude-mem-worker.sh hook codebuddy

# pi
pi -p "请只回复：回测测试"

# Hermes：当前 gateway 会话的下一轮对话自动触发
```

### 3.2 等待 worker LLM 处理（8~20 秒）

### 3.3 查库验收三件套

```bash
DB=~/.claude-mem/claude-mem.db
# 最近 observation（应出现刚才测试的摘要）
sqlite3 "$DB" "SELECT datetime(created_at_epoch/1000,'unixepoch','+8 hours'), project, substr(narrative,1,40) FROM observations ORDER BY created_at_epoch DESC LIMIT 3;"
# 最近 summary（应生成会话总结）
sqlite3 "$DB" "SELECT datetime(created_at_epoch/1000,'unixepoch','+8 hours'), project, substr(request,1,40) FROM session_summaries ORDER BY created_at_epoch DESC LIMIT 3;"
```

### 3.4 验收判定（全部满足才算通过）

| 项 | 判定 |
|---|---|
| user_prompt 落库 | 有该测试会话记录，文本为真实消息（非 `[media prompt]`） |
| observation 落库 | 有该测试会话摘要（narrative 非空） |
| summary 落库 | 有该测试会话总结（request 非空） |
| `[media prompt]` 增量 | 0（修复后不产生空 init） |

---

## 四、记忆召回验收

```bash
# worker search API 检索历史记忆
curl -s "http://127.0.0.1:37701/api/search/observations?query=<关键词>&limit=3"
# 期望：返回 JSON content[]，含匹配的 observation 标题/正文
```

**判定**：检索到与关键词相关的 observation 记录即通过（含历史会话内容）。

---

## 五、快速全量验收（一条命令查所有 agent 活跃度）

```bash
DB=~/.claude-mem/claude-mem.db
NOW=$(python3 -c "import time; print(int(time.time()*1000))")
echo "=== 近30分钟捕获活跃度 ==="
sqlite3 "$DB" "SELECT project, count(*) FROM observations WHERE created_at_epoch > $((NOW-1800000)) GROUP BY project ORDER BY count(*) DESC;"
echo "=== 近1小时总结活跃度 ==="
sqlite3 "$DB" "SELECT project, count(*) FROM session_summaries WHERE created_at_epoch > $((NOW-3600000)) GROUP BY project ORDER BY count(*) DESC;"
echo "=== 记忆召回 ==="
curl -s "http://127.0.0.1:37701/api/search/observations?query=test&limit=2"
echo "=== [media prompt] 增量（应0）==="
sqlite3 "$DB" "SELECT count(*) FROM user_prompts WHERE prompt_text LIKE '%[media prompt]%' AND created_at_epoch > $((NOW-86400000));"
```

---

## 六、回测记录模板

| 项 | 值 |
|---|---|
| 回测日期 | YYYY-MM-DD |
| 环境 | 本机 / cc-connect / 换机 |
| worker 版本 | v13.18.0 |
| worker 健康 | degraded=false, lastInteraction 非 null |
| opencode | up/obs/summary 时间 + 通过✓ |
| CodeBuddy | up/obs/summary 时间 + 通过✓ |
| pi (pi-claude-mem) | up/obs/summary 时间 + 通过✓ |
| Hermes | up/obs/summary 时间 + 通过✓ |
| 记忆召回 | 检索关键词 + 命中数 |
| `[media prompt]` 增量 | 0 |
| **结论** | 全部通过 / 失败项 |

---

## 七、坑位速查（回测中易误判）

1. **hook 系 agent（codebuddy/hermes）observation 落 `project='unknown'`** —— 按 project 名过滤会误判空白，应按 created_at 时间倒序查。
2. **memory_session_id 会变** —— summarize 时 worker 可能给会话换新 id，按 session_db_id 关联可能查不到，用最终 memory_session_id 或内容匹配。
3. **单次 `opencode run` 偶发缺 summary** —— `session.idle` 事件触发不稳定（边缘情况），交互式/cc-connect 会话 summary 稳定；回测以真实使用场景为准。
4. **worker 健康三查** —— `dependencies.degraded`（缺 claude CLI？）、`ai.lastInteraction`（null=LLM 没调过）、`ai.provider`（走哪条链路）。
5. **`[media prompt]` ≠ 数据正常** —— 说明某 agent 发了空 init，是缺陷信号不是正常现象。
