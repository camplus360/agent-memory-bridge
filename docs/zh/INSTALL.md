# claude-mem 统一接入安装指南（详细版）

> 目标：把 **opencode / CodeBuddy / Codex CLI / pi / Hermes** 五个 agent 的对话记忆，全部自动捕获并写入同一个
> 本机 claude-mem worker（`127.0.0.1:37701`）。
> 所有 agent 统一通过本目录的 `claude-mem-worker.py` 对接 worker（opencode/pi 为原生参考实现，字段一致）。

---

## 〇、整体架构（先看清再装）

```
  opencode ─┐
  CodeBuddy ─┤
  Codex CLI ─┼─► claude-mem-worker.py（单一真相源）─► claude-mem worker :37701 ─► SQLite + Chroma
  pi ───────┤      （init/observation/summarize）      （总结/embedding/检索）
  Hermes ───┘
```

- worker 负责：LLM 总结、embedding、向量检索、去重合并。**五个 agent 共享同一记忆库**。
- 每个 agent 只负责「捕获对话 → 调 worker」，不重复实现记忆逻辑。
- 会话隔离：每个 agent 用前缀区分（`opencode-` / `codebuddy-` / `codex-` / `pi-` / `hermes-`），同名 sessionId 不会混写。

---

## 一、前置：拿到仓库 + 启动 worker

### 1.1 取得代码

```bash
# 克隆或拷贝本目录到目标机器任意位置
git clone <repo-url> agent-memory-bridge
cd agent-memory-bridge
ls                      # 应看到 claude-mem-worker.py  install.sh  README.md  agents/
```

### 1.2 安装并启动 claude-mem worker

worker 是记忆后端，**必须先起来**，否则所有 agent 捕获会静默失败（不阻塞 agent）。

```bash
# 安装 claude-mem（若尚未安装）
npx claude-mem install

# 启动 worker（推荐用 systemd user service，见下方“常驻”）
systemctl --user status claude-mem-worker 2>/dev/null \
  || (curl -s -m 2 http://127.0.0.1:37701/api/health >/dev/null \
        && echo "worker 已在运行" \
        || echo "worker 未运行，需启动")

# 确认健康
curl -s http://127.0.0.1:37701/api/health
# 期望: {"status":"ok","initialized":true,...,"dependencies":{"degraded":false,...}}
```

**常驻启动（推荐）**——用 systemd user service（示例，按实际 worker 路径调整）：

```bash
# 典型路径：~/.codebuddy/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/claude-mem-worker.service <<'EOF'
[Unit]
Description=claude-mem worker
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/bun ~/.codebuddy/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs
Restart=on-failure
Environment=CLAUDE_MEM_WORKER_HOST=127.0.0.1
Environment=CLAUDE_MEM_WORKER_PORT=37701

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now claude-mem-worker
```

> ⚠️ **worker 端口坑**：实际端口**大概率不是** 37777，而是 `37701`。
> 务必以 `curl :37701/api/health` 能返回 `ok` 为准，并在 `~/.claude-mem/settings.json` 写
> `CLAUDE_MEM_WORKER_PORT: 37701`（**数字**，不要加引号）。
> settings.json **必须是合法 JSON**（不能有 `//` 注释），否则 pi 插件会静默 fallback 到 37777。

> ⚠️ **AI provider 必须配**：worker 只捕获、不总结，除非配好 provider
> （`~/.claude-mem/settings.json` 的 `CLAUDE_MEM_OPENROUTER_API_KEY` 等）。
> 没配 → 连得上但不产生记忆（会话一直 `active`）。

> ⚠️ **Agent 模式必须配 `CLAUDE_CODE_PATH`（本次踩坑重灾区）**：默认 `CLAUDE_MEM_PROVIDER=claude`
> 时，observation/summarize 走 **Agent SDK → spawn claude CLI 子进程 → ARK** 三层链路，**本机必须能找到 claude 执行器**。
> worker 服务 PATH 常不含 `~/.npm-global/bin`（claude 所在处），导致 `degraded=true`、报 `claude_cli setup_required`、
> observations/summaries 表**永远不涨**（user_prompts 正常，易误判）。
> 修复：在 settings.json 加 `"CLAUDE_CODE_PATH": "/home/yourname/.npm-global/bin/claude"` 后重启 worker。
> **完整原理与排障见 [AGENT-RUNTIME-ARCH.md](./AGENT-RUNTIME-ARCH.md)。**

---

## 二、一键安装各 agent 接入

```bash
cd agent-memory-bridge
./install.sh --all        # 安装全部 5 个 agent
# 或选择性安装：
./install.sh --agent opencode
./install.sh --agent codebuddy
./install.sh --agent codex
./install.sh --agent hermes
# 调试用：
./install.sh --dry-run              # 只打印要做什么
./install.sh --prefix /opt/claude-mem   # 指定安装根（默认 ~/.local/share/claude-mem）
```

`install.sh` 会做：
1. 复制 `claude-mem-worker.py` → 安装根（默认 `~/.local/share/claude-mem/`）；
2. 生成 `.env` 模板（host/port/超时/重试）；
3. 按所选 agent 把接入落到真实位置（见下表）。

| Agent | 安装落点 | 之后还需手动启用？ |
|---|---|---|
| **opencode** | `~/.config/opencode/plugins/claude-mem-capture/` | 是，在 `opencode.json` 注册插件（见 §三.1） |
| **pi** | 安装根 `agents/pi/`（参考实现 + DEPLOY.md） | 是，按 DEPLOY.md 部署到 npm 包（见 §三.3） |
| **codebuddy** | `~/.codebuddy/hooks.claude-mem.json` | 是，并入 `hooks.json`（见 §三.2） |
| **codex** | `~/.codex/hooks.json`（合并，保留已有 hook）+ `[features] hooks=true` | 是，在 `/hooks` 信任一次，或 headless 用 `--dangerously-bypass-hook-trust`（见 §三.5） |
| **Hermes** | 安装根 `agents/hermes/engine.py.example` | 是，粘进 engine.py 事件点（见 §三.4） |

> 覆盖环境变量：`CLAUDE_MEM_WORKER_HOST` / `CLAUDE_MEM_WORKER_PORT` / `CLAUDE_MEM_INSTALL_ROOT`

---

## 三、各 agent 启用细节

### 3.1 opencode（原生插件，有单测）

**两种启用方式（推荐方式②，与实测一致）**：

**方式②（推荐，直接引用本仓库 master，改动即时生效）**：在 `~/.config/opencode/opencode.json` 的 `"plugin"` 数组加本仓库 `agents/opencode` 目录：
```json
{
  "plugin": [
    "/ABS/PATH/agent-memory-bridge/agents/opencode"
  ]
}
```
> 优点：改 master 代码即改即用，无需二次拷贝；缺点：换机需确保该路径存在。

**方式①（拷贝到 opencode 配置目录）**：`install.sh` 已把 `index.js`（+ `index.test.js` / `package.json`）放到 `~/.config/opencode/plugins/claude-mem-capture/`：
```json
{
  "plugin": [
    "/home/yourname/.config/opencode/plugins/claude-mem-capture"
  ]
}
```

⚠️ **双份捕获坑**：官方 shim `~/.config/opencode/plugins/claude-mem.js` 与本插件钩子重合。
**务必只保留一个**——从 `plugin` 数组里移除官方 `./plugins/claude-mem.js`（不要两者共存）。

⚠️ **插件导出格式**：本插件按官方 `PluginModule` 规范 `export default { id, server }`。
若 opencode 不识别（不打印 `[claude-mem] capture plugin loading`），多半是加载了旧版/官方 shim，核对 plugin 数组指向。

重启 opencode 生效。

**跑单测（可选，验证捕获逻辑）**：
```bash
cd /ABS/PATH/agent-memory-bridge/agents/opencode
bun test index.test.js        # 或 npm test
```

---

### 3.2 CodeBuddy（hooks 调 worker 脚本）

`install.sh` 生成：`~/.codebuddy/hooks.claude-mem.json`（路径占位符已替换为真实绝对路径）。

**⚠️ 生效位置（实测关键坑）**：CodeBuddy 的 hooks **必须合并进 `~/.codebuddy/settings.json` 的 `"hooks"` 字段**。
独立 `~/.codebuddy/hooks.json`（用户级）**不会读取**——只认 settings.json。别被 hooks.json.example / hooks.claude-mem.json 误导，那只是内容来源，不是生效位置。

**启用**：把 hooks.claude-mem.json 里的 `"hooks"` 对象合并进 `~/.codebuddy/settings.json` 的 `"hooks"` 字段（注意不覆盖已有 hook，且 **settings.json 必须是合法 JSON，不能有注释**）。

实测生效配置（四个事件，全部指向统一脚本）：
```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABSOLUTE>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABSOLUTE>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABSOLUTE>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABSOLUTE>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }]
  }
}
```
其中 `<ABSOLUTE>` 是本机 `claude-mem-worker.py` 的**绝对路径**（如 `/home/yourname/.local/share/claude-mem/claude-mem-worker.py`）。


---

### 3.5 Codex CLI（hooks 调 worker 脚本）

要求 Codex CLI **≥ 0.131**（在 0.142.4 上实测）。`install.sh --agent codex` 会：

1. 幂等**合并**四个 worker hook 到 `~/.codex/hooks.json`，保留已有 hook（例如 `herdr-agent-state.sh` 的 SessionStart hook —— 两者会同时运行）；
2. 渲染 worker 绝对路径（`/usr/bin/python3 <安装根>/claude-mem-worker.py hook codex`）；
3. 在 `~/.codex/config.toml` 幂等启用 `[features] hooks = true`；
4. 首次改动前把旧 `hooks.json` 备份为 `hooks.json.bak-claude-mem-<时间戳>`。

与 CodeBuddy 不同，Codex **直接读取独立的 `~/.codex/hooks.json`**（不要放进 config.toml），且该文件是严格 JSON（`deny_unknown_fields`，不能有 `_comment` 键）。

**hook 信任 —— 唯一需要的手动步骤。** 非受管 command hook 必须先审查才能运行：

- **交互式（持久）**：启动 `codex`，打开 `/hooks`，审查并信任这四个条目一次。信任以 hook 哈希存入 config.toml 的 `[hooks.state]`，仅当 hook 命令变更时才需重新信任。
- **无头（`codex exec`）**：每次调用加 `--dangerously-bypass-hook-trust`。官方有意不提供持久配置项（upstream PR openai/codex#21768）。

```bash
codex exec --skip-git-repo-check --dangerously-bypass-hook-trust "你的任务"
```

hook 以普通用户权限运行，可连通 `127.0.0.1:37701`；实测一次运行产生了标记为 `platformSource=codex` 的一条 prompt + 一条 observation + 一条 summary。


---


### 3.3 pi（原生扩展，npm 包）

pi 是 npm 包，**不能直接覆盖**，需按 `agents/pi/DEPLOY.md` 部署。要点：

```bash
# 1) 装 pi（注意真实包名是 @earendil-works/pi-coding-agent）
npm install -g @earendil-works/pi-coding-agent
export PATH="$HOME/.npm-global/bin:$PATH"     # 否则敲 pi 报 command not found

# 2) 把本仓库 agents/pi 目录注册为本地路径包
cd agent-memory-bridge/agents/pi
pi install "$PWD"
#    确认 ~/.pi/agent/settings.json 的 packages 已含绝对路径
#    .../agent-memory-bridge/agents/pi

# 3) 重启 pi 并验证（扩展仅启动时加载一次）
pi
> /memory-status
# 期望: 已连接 worker v13.18.0 @ http://127.0.0.1:37701
```

> 完整坑位表见 `agents/pi/DEPLOY.md`（端口 fallback 37777、settings.json 合法性、provider 缺失等）。

---

### 3.4 Hermes（engine.py 注入）

`install.sh` 生成：`~/.local/share/claude-mem/agents/hermes/engine.py.example`

**启用**：把该文件里的 3 个函数（`hermes_on_session_start/on_assistant/on_session_end`）
粘进 Hermes 的真实 `engine.py`，并在对应事件点调用：

```python
from your.path import hermes_on_assistant, hermes_on_session_start, hermes_on_session_end

# 会话开始
hermes_on_session_start(session_id, cwd, project, first_user_msg)

# 每轮助手回复结束
hermes_on_assistant(session_id, assistant_text, cwd)

# 会话结束
hermes_on_session_end(session_id, last_assistant_text)
```

调用走后台线程、失败静默，**绝不阻塞 Hermes 主流程**。脚本路径在 `engine.py.example` 顶部
`CLAUDE_MEM_WORKER_PY` 常量里改成你机器上的绝对路径。

---

## 四、统一脚本用法（所有 shell 型 agent 通用）

```bash
python3 claude-mem-worker.py init        <agent> <sessionId> [cwd] [project] [prompt]
python3 claude-mem-worker.py observation <agent> <sessionId> <text> [cwd] [toolName] [platformSource]
python3 claude-mem-worker.py summarize   <agent> <sessionId> [lastAssistantMessage] [platformSource]
python3 claude-mem-worker.py turn        <agent> <sessionId> <transcriptPath> [cwd] [platformSource]
python3 claude-mem-worker.py search      <query> [limit]
python3 claude-mem-worker.py health
```

`<agent>` 区分来源（`codebuddy` / `codex` / `hermes` / ...），自动拼成 `${agent}-${sessionId}`。

**环境变量**：`CLAUDE_MEM_WORKER_HOST`(默认127.0.0.1) / `CLAUDE_MEM_WORKER_PORT`(37701) /
`CLAUDE_MEM_HTTP_TIMEOUT`(8s) / `CLAUDE_MEM_HTTP_RETRIES`(2) / `CLAUDE_MEM_QUIET`(0)。

worker 不可达时脚本**静默 exit 0**，不阻塞 agent。

---

## 五、端到端验证

### 5.1 冒烟测试（无需真实对话）

```bash
# 用统一脚本直接打 worker
W="python3 ~/.local/share/claude-mem/claude-mem-worker.py"
for a in opencode codebuddy codex pi hermes; do
  $W init $a s1 /tmp
  $W observation $a s1 "测试文本 $a" /tmp assistant_message $a
  $W summarize $a s1 "" $a
done

# 看计数是否增长
curl -s http://127.0.0.1:37701/api/stats
# 期望 sessions / observations 增加
```

### 5.2 真实对话验证

- **opencode**：开会话聊几句 → 空闲后看是否弹 “记忆已保存” toast；`curl :37701/api/stats` observations+。
- **CodeBuddy**：正常对话一轮 → `curl :37701/api/stats` 应有该 session 的 observation。
- **Codex CLI**：在 `/hooks` 信任后（或带 `--dangerously-bypass-hook-trust`）跑一轮，应出现 `platform_source=codex` 的新会话及 prompt/observation/summary。
- **pi**：`/memory-status` 显示已连接；聊完看 summaries 增长。
- **Hermes**：对话结束 → 查 worker stats。

### 5.3 语义检索验证

```bash
curl -s "http://127.0.0.1:37701/api/search/observations?query=你的关键词&limit=5"
```

---

## 六、故障排查速查

| 现象 | 原因 | 解决 |
|---|---|---|
| 全 agent 无记忆 | worker 没起 | `curl :37701/api/health` 应为 ok；启动 worker |
| 连得上但不产生记忆 | AI provider 未配 | 配 `CLAUDE_MEM_OPENROUTER_API_KEY` 等，重启 worker |
| opencode 双份写入 | 官方 shim 与插件共存 | `opencode.json` 的 `plugin` 只留一个 |
| CodeBuddy 双份写入 | MCP 版 + hook 版共存 | 只留 hook 版 |
| Codex hook 完全不触发 | hook 未受信任（headless `codex exec` 跳过未信任 hook） | 在 `/hooks` 信任一次，或加 `--dangerously-bypass-hook-trust` |
| Codex 报 `invalid type … expected struct HooksToml` | 误把 config.toml 的 `hooks` 写成路径字符串 | hook 放进 `~/.codex/hooks.json`；config.toml 只需 `[features] hooks=true` |
| pi 连 37777 失败 | settings.json 非法 JSON / 端口写成字符串 | 改合法 JSON + 数字端口 37701 |
| 敲 `pi` 报 command not found | `~/.npm-global/bin` 不在 PATH | `export PATH="$HOME/.npm-global/bin:$PATH"` |
| hook 调用报错 | 路径占位符未替换 / 变量名不符 | 检查 `hooks.claude-mem.json` 路径；按 CodeBuddy 实际变量调整 |

---

## 七、卸载 / 重装

```bash
# 重装统一脚本（覆盖）
./install.sh --agent codebuddy --prefix ~/.local/share/claude-mem

# 移除 opencode 插件：从 opencode.json 的 plugin 数组删掉该目录
# 移除 CodeBuddy：删 hooks.json 里对应 command
# 移除 Codex：从 ~/.codex/hooks.json 删四个 worker 命令（herdr hook 保持不动）
# 移除 pi：pi remove /绝对路径/agent-memory-bridge/agents/pi
# 移除 Hermes：删 engine.py 里注入的函数调用
```
