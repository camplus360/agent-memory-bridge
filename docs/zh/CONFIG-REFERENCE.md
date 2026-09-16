# claude-mem 四 Agent 可复用配置参考（实测版）

> 本文档记录**本机实测生效**的四 agent 接入配置 + 本次排障沉淀的避坑点。
> 与 `INSTALL.md`（安装流程）、`AGENT-RUNTIME-ARCH.md`（worker 原理）互补，
> 本文是**可直接复制的配置快照**。新机器部署时按此核对。

---

## 〇、前置：worker 必须可用（一切前提）

```bash
curl -s http://127.0.0.1:37701/api/health | python3 -m json.tool
# 期望：status=ok, initialized=true, dependencies.degraded=false
```

**worker 健康三查**（排障优先看这三项，别先怀疑接线）：
| health 字段 | 正常值 | 异常含义 |
|---|---|---|
| `ai.lastInteraction` | 非 null（有 LLM 调用记录） | null = 从未成功调过 LLM |
| `dependencies.degraded` | false | true = claude CLI 缺失（`claude_cli setup_required`） |
| `ai.provider` | claude / openrouter / gemini | 决定走哪条链路 |

**worker 必配（两种互斥方案，见 AGENT-RUNTIME-ARCH.md 五节）**：
- 方案① claude（默认）：必须装 Claude Code + `CLAUDE_CODE_PATH` 指向 claude 绝对路径
- 方案② openrouter/gemini：不依赖 claude CLI，配 key+model

```json
// ~/.claude-mem/settings.json（关键项，其余可留默认）
{
  "CLAUDE_MEM_RUNTIME": "worker",
  "CLAUDE_MEM_WORKER_PORT": 37701,
  "CLAUDE_MEM_WORKER_HOST": "127.0.0.1",
  "CLAUDE_MEM_PROVIDER": "claude",
  "CLAUDE_CODE_PATH": "/home/yourname/.npm-global/bin/claude",
  "ANTHROPIC_BASE_URL": "https://your-gateway.example.com/api/plan",
  "ANTHROPIC_AUTH_TOKEN": "<ark-token>"
}
```

---

## 一、opencode（原生插件，方式②推荐）

**生效文件**：`~/.config/opencode/opencode.json` → `"plugin"` 数组

```json
{
  "plugin": [
    "/ABS/PATH/hook-sh-worker/agents/opencode"
  ]
}
```

| 坑 | 说明 |
|---|---|
| 双份捕获 | 移除官方 `./plugins/claude-mem.js`，只留本插件 |
| 导出格式 | 必须 `export default { id, server }`（PluginModule 规范） |
| 加载验证 | 启动应打印 `[claude-mem] capture plugin loading` |
| 重启 | 改配置后需重启 opencode 才重载 |

**事件捕获**：`chat.message`（user→init，assistant→observation）、`tool.execute.after`（工具结果）、`session.idle`（summarize）。

---

## 二、CodeBuddy（hook 方式，⚠️ 位置最关键）

**生效文件**：`~/.codebuddy/settings.json` 的 **`"hooks"` 字段**（不是独立 hooks.json！）

```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "<ABS>/claude-mem-worker.sh hook codebuddy", "timeout": 10000 }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<ABS>/claude-mem-worker.sh hook codebuddy", "timeout": 10000 }] }],
    "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "<ABS>/claude-mem-worker.sh hook codebuddy", "timeout": 10000 }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "<ABS>/claude-mem-worker.sh hook codebuddy", "timeout": 10000 }] }]
  }
}
```
`<ABS>` = `claude-mem-worker.sh` 本机绝对路径（如 `/home/yourname/.local/share/claude-mem/claude-mem-worker.sh`）。

| 坑 | 说明 |
|---|---|
| ⚠️ 生效位置 | **settings.json 的 hooks 字段**；独立 `~/.codebuddy/hooks.json` 不读取 |
| JSON 合法性 | settings.json 必须合法 JSON，**不能有注释**（合并前删掉 example 的 `_comment`） |
| 事件映射 | SessionStart→init；UserPromptSubmit→observation(user)；PostToolUse→observation(工具)；Stop→summarize |
| 三层结构 | 必须 `事件名→matcher→hooks[]`；扁平写法不触发 |
| 双份 | 移除 MCP 版记忆，只留 hook 版 |

---

## 三、pi（原生扩展，npm 包）

**生效**：`~/.pi/agent/settings.json` 的 `packages` 含 `npm:pi-agent-memory`，包内 `extensions/pi-mem.ts` 与本仓库同步。

```bash
# 装 pi（真实包名）
npm install -g @earendil-works/pi-coding-agent
export PATH="$HOME/.npm-global/bin:$PATH"

# 装记忆扩展
pi install npm:pi-agent-memory

# 同步主副本到 npm 包
cd hook-sh-worker/agents/pi && ./install.sh sync

# 验证
pi > /memory-status
# 期望: 已连接 worker v13.18.0 @ http://127.0.0.1:37701
```

| 坑 | 说明 |
|---|---|
| 端口 | 实测 37701（非 37777），settings.json 写数字不加引号 |
| 同步 | 改 pi-mem.ts 需 `./install.sh sync` 覆盖 npm 包副本 |
| provider | worker 没配 LLM → 连得上但不产生记忆 |

---

## 四、Hermes（gateway 注入）

**生效**：`hermes-agent/gateway/run_turn.py` 的 `_capture_claude_mem_turn`（不是 hermes-hudui/engine.py！）

⚠️ **Hermes 有两个捕获点**：
1. `hermes-hudui/backend/chat/engine.py` → `_capture_turn_claude_mem`（Web UI）
2. `hermes-agent/gateway/run_turn.py` → `_capture_claude_mem_turn`（**实际运行的消息 gateway**）

**修复必改两处**，改一处另处仍产。当前运行的是 `hermes_cli.main gateway run`（`hermes-gateway.service`），加载的是 run_turn.py。

**捕获要点**（run_turn.py 里 subprocess 调用）：
```python
if str(user_content or "").strip():        # 必须非空才 init
    subprocess.run(["bash", _CAPTURE_SCRIPT, "init", "hermes", session_id, cwd, "",
                    str(user_content)], ...)   # 第5参=prompt，漏传会被兜底成 [media prompt]
```

| 坑 | 说明 |
|---|---|
| 漏传 prompt | init 第 5 位置参数漏传 → worker 兜底 `[media prompt]` |
| 空 init | 无用户文本不建会话（`if user_content.strip()`） |
| 服务重启 | 改 run_turn.py 后**必须重启** `hermes-gateway.service` 才加载；且 agent 自身无法重启 gateway，需用户在外部终端执行 |
| 验证入口 | `_capture_claude_mem_turn` 只在 gateway 回合结束后异步触发；`hermes chat -q` CLI 不经过它，别用它验证 |

---

## 五、快速验收清单（四 agent 全链路）

```sql
-- 在 ~/.claude-mem/claude-mem.db 查最近三件套（epoch 是毫秒，/1000 换算）
SELECT 'user_prompt', max(datetime(created_at_epoch/1000,'unixepoch','+8 hours'))
  FROM user_prompts WHERE content_session_id LIKE 'opencode-%'
UNION ALL SELECT 'observation', max(datetime(created_at_epoch/1000,'unixepoch','+8 hours'))
  FROM observations WHERE project='opencode';
-- 对 codebuddy/pi/hermes 同理；hermes/codebuddy 的 observation project 多为 'unknown'
```

**通则**：
- user_prompts 正常、observations/summaries 不涨 → worker LLM 路径断（查 CLAUDE_CODE_PATH / health.degraded）
- 出现 `[media prompt]` → 某 agent 发空 init（查 user_prompts 前缀定位）
- 重启后增量断言：`SELECT count(*) FROM user_prompts WHERE prompt_text LIKE '%[media prompt]%' AND created_at_epoch > <重启时刻ms>` 应为 0

---

## 六、本次实测结论（2026-09-09）

| Agent | 接入 | user_prompt | observation | summary | 状态 |
|---|---|---|---|---|---|
| opencode | 插件 | 09:20 | 09:21 ✅ | 09:21 ✅ | ✅ |
| codebuddy | hook | 09:52(实测) | 09:53 ✅ | init已通 | ✅ |
| pi | 扩展 | 09:13 | 09:37 ✅ | — | ✅ |
| hermes | gateway | 09:48 | 09:53 ✅ | 09:48 ✅ | ✅ |

修复后 `[media prompt]` 增量 = **0**。两处修复：① run_turn.py 空 init ② worker CLAUDE_CODE_PATH。
