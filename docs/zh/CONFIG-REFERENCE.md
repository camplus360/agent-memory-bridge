# claude-mem 五 Agent 可复用配置参考（实测版）

> 本文档记录**本机实测生效**的五 agent（opencode / CodeBuddy / Codex CLI / pi / Hermes）接入配置 + 本次排障沉淀的避坑点。
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
    "/ABS/PATH/agent-memory-bridge/agents/opencode"
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
    "SessionStart":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABS>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABS>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABS>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABS>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }]
  }
}
```
`<ABS>` = `claude-mem-worker.py` 本机绝对路径（如 `/home/yourname/.local/share/claude-mem/claude-mem-worker.py`）。

| 坑 | 说明 |
|---|---|
| ⚠️ 生效位置 | **settings.json 的 hooks 字段**；独立 `~/.codebuddy/hooks.json` 不读取 |
| JSON 合法性 | settings.json 必须合法 JSON，**不能有注释**（合并前删掉 example 的 `_comment`） |
| 事件映射 | SessionStart→init；UserPromptSubmit→observation(user)；PostToolUse→observation(工具)；Stop→summarize |
| 三层结构 | 必须 `事件名→matcher→hooks[]`；扁平写法不触发 |
| 双份 | 移除 MCP 版记忆，只留 hook 版 |

---

## 三、Codex CLI（hook 方式，⚠️ 信任最关键）

**生效文件**：独立的 **`~/.codex/hooks.json`**（Codex 直接读取；**不要**放进 config.toml）+ `~/.codex/config.toml` 里的 `[features] hooks = true`。安装器会自动合并这两处。

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "/usr/bin/python3 <ABS>/claude-mem-worker.py hook codex", "timeout": 15000 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/usr/bin/python3 <ABS>/claude-mem-worker.py hook codex", "timeout": 15000 }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "/usr/bin/python3 <ABS>/claude-mem-worker.py hook codex", "timeout": 15000 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "/usr/bin/python3 <ABS>/claude-mem-worker.py hook codex", "timeout": 15000 }] }]
  }
}
```
`<ABS>` = 安装根（默认 `/home/yourname/.local/share/claude-mem`）。建议用绝对路径 `/usr/bin/python3`，确保 hook 沙箱下能解析解释器。

| 坑 | 说明 |
|---|---|
| ⚠️ **hook 信任** | 非受管 hook 在审查前会被跳过。交互式在 `/hooks` 信任一次（持久化到 `[hooks.state]`）；headless `codex exec` 加 `--dangerously-bypass-hook-trust`（官方有意不提供持久开关，upstream #21768） |
| 生效位置 | 独立 `~/.codex/hooks.json`（与 CodeBuddy 不同，**不是** settings.json）；config.toml 只放 `[features] hooks=true` |
| 严格 JSON | `deny_unknown_fields`——放 `_comment` 键会导致整个文件加载失败 |
| `hooks = "..."` 报错 | `invalid type: string, expected struct HooksToml` 表示你在 config.toml 把 hooks 写成了路径；删掉并改用 hooks.json |
| 事件映射 | SessionStart 接收/no-op；UserPromptSubmit→init+prompt；PostToolUse→observation(工具)；Stop→summarize（透传 last_assistant_message） |
| 共存 | 其他 hook（如 `herdr-agent-state.sh`）继续运行；安装器只追加、不覆盖 |

已在 Codex CLI 0.142.4 上端到端实测：一次 bypass-trust 的 `codex exec` 产生 `platform_source=codex` 的一条 prompt + 一条 observation + 一条 summary。

---

## 四、pi（原生扩展，本地路径包）

**生效**：`~/.pi/agent/settings.json` 的 `packages` 含本仓库 `agents/pi` 目录的绝对路径。包清单 `pi.extensions` 指向 `extensions/pi-claude-mem.ts`，pi 直接从仓库目录加载——不拷贝、无同步步骤。

```bash
# 装 pi（真实包名）
npm install -g @earendil-works/pi-coding-agent
export PATH="$HOME/.npm-global/bin:$PATH"

# 以本地路径包注册记忆扩展（在本仓库 clone 内）
cd agent-memory-bridge/agents/pi
pi install "$PWD"

# 验证（先重启 pi）
pi > /memory-status
# 期望: 已连接 worker v13.18.0 @ http://127.0.0.1:37701
```

扩展默认 spawn 统一 `claude-mem-worker.py` shim 发起每次 worker 调用
（`CLAUDE_MEM_TRANSPORT=py`）；设 `CLAUDE_MEM_TRANSPORT=http` 可回退旧的进程内 fetch。
详见 [`agents/pi/DEPLOY.md`](../../agents/pi/DEPLOY.md)。

| 坑 | 说明 |
|---|---|
| 端口 | 实测 37701（非 37777），settings.json 数字或字符串均可 |
| 重载 | 改 `.ts` 或 `packages` 路径后必须退出并重开 pi（扩展仅启动时加载一次） |
| provider | worker 没配 LLM → 连得上但不产生记忆 |

---

## 五、Hermes（gateway 注入）

**生效**：`hermes-agent/gateway/run_turn.py` 的 `_capture_claude_mem_turn`（不是 hermes-hudui/engine.py！）

⚠️ **Hermes 有两个捕获点**：
1. `hermes-hudui/backend/chat/engine.py` → `_capture_turn_claude_mem`（Web UI）
2. `hermes-agent/gateway/run_turn.py` → `_capture_claude_mem_turn`（**实际运行的消息 gateway**）

**修复必改两处**，改一处另处仍产。当前运行的是 `hermes_cli.main gateway run`（`hermes-gateway.service`），加载的是 run_turn.py。

**捕获要点**（run_turn.py 里 subprocess 调用）：
```python
if str(user_content or "").strip():        # 必须非空才 init
    subprocess.run([sys.executable, CLAUDE_MEM_WORKER_PY, "init", "hermes", session_id, cwd, "",
                    str(user_content)], ...)   # 第5参=prompt，漏传会被兜底成 [media prompt]
```

| 坑 | 说明 |
|---|---|
| 漏传 prompt | init 第 5 位置参数漏传 → worker 兜底 `[media prompt]` |
| 空 init | 无用户文本不建会话（`if user_content.strip()`） |
| 服务重启 | 改 run_turn.py 后**必须重启** `hermes-gateway.service` 才加载；且 agent 自身无法重启 gateway，需用户在外部终端执行 |
| 验证入口 | `_capture_claude_mem_turn` 只在 gateway 回合结束后异步触发；`hermes chat -q` CLI 不经过它，别用它验证 |

---

## 六、快速验收清单（五 agent 全链路）

```sql
-- 在 ~/.claude-mem/claude-mem.db 查最近三件套（epoch 是毫秒，/1000 换算）
SELECT 'user_prompt', max(datetime(created_at_epoch/1000,'unixepoch','+8 hours'))
  FROM user_prompts WHERE content_session_id LIKE 'opencode-%'
UNION ALL SELECT 'observation', max(datetime(created_at_epoch/1000,'unixepoch','+8 hours'))
  FROM observations WHERE project='opencode';
-- 对 codebuddy/codex/pi/hermes 同理；hermes/codebuddy/codex 的 observation project 多为 'unknown'
```

**通则**：
- user_prompts 正常、observations/summaries 不涨 → worker LLM 路径断（查 CLAUDE_CODE_PATH / health.degraded）
- 出现 `[media prompt]` → 某 agent 发空 init（查 user_prompts 前缀定位）
- 重启后增量断言：`SELECT count(*) FROM user_prompts WHERE prompt_text LIKE '%[media prompt]%' AND created_at_epoch > <重启时刻ms>` 应为 0

---

## 七、本次实测结论

| Agent | 接入 | user_prompt | observation | summary | 状态 |
|---|---|---|---|---|---|
| opencode | 插件 | recorded | ✅ | ✅ | ✅ |
| codebuddy | hook | recorded | ✅ | ✅ | ✅ |
| codex (0.142.4) | hook | recorded | ✅ | ✅ | ✅ |
| pi | 扩展 | recorded | ✅ | — | ✅ |
| hermes | gateway | recorded | ✅ | ✅ | ✅ |

修复后 `[media prompt]` 增量 = **0**。历史两处修复：① run_turn.py 空 init ② worker CLAUDE_CODE_PATH。
