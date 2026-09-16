# claude-mem 架构与部署配置文档

> 核心区分：**claude-mem worker 存在两套独立通路，不能混为一谈。**
> 一个只做数据存取（不依赖 claude CLI），一个做智能压缩（依赖 claude CLI）。

---

## 1. 核心架构：两条链路

### 链路 1️⃣ REST 落库（不依赖 claude CLI）
负责会话初始化、接收 hook 投递对话、入队、SQLite/向量库持久化。
**仅做数据存取排队，不做摘要、事实抽取**；即便找不到 claude 程序，这一部分依然正常运行。

```
IDE Hook → worker(37701) → 存储（SQLite / Chroma）
```

### 链路 2️⃣ Agent 智能压缩（`CLAUDE_MEM_PROVIDER=claude` 时强依赖 claude CLI）
用于生成 observation、会话摘要、事实提取、结构化 XML 输出——**记忆压缩核心逻辑**。

```
claude-mem worker
│  Agent SDK 调度，spawn 子进程
▼
claude CLI（Agent Runtime：agent loop、权限控制、内置 system prompt、工具流程）
│  读取环境 ANTHROPIC_BASE_URL / AUTH_TOKEN
▼
LLM 后端（Anthropic / ARK 代理网关）
```

> ⚠️ **重点**：`ANTHROPIC_BASE_URL` 只是给 claude CLI 指定上游网关，**不能替代 claude CLI 本身**。
> SDK 在这里不是简单 HTTP 客户端，作用是**拉起、管控、收发 stdio JSON 流**。
> 找不到 claude 执行器 → `degraded=true`，报错 `claude_cli setup_required`。

> 🧭 **端口**：worker 实际监听 **`37701`**（不是 37777）。以 `curl :37701/api/health` 能返回 `ok` 为准，
> 并在 `~/.claude-mem/settings.json` 写 `CLAUDE_MEM_WORKER_PORT: 37701`（数字，勿加引号）。

---

## 2. 两种运行模式（互斥，二选一）

### 模式 A：Claude Agent SDK 模式（默认 `claude` provider）
- ✅ 能力：完整智能压缩、observation 抽取、结构化记忆
- ⚠️ 依赖条件：
  - 本机必须安装 **Claude Code CLI**（`claude` 二进制）
  - 环境变量 `CLAUDE_CODE_PATH` 正确指向 claude 可执行文件
  - PATH 能定位 claude，**或**显式配置 `CLAUDE_CODE_PATH`
  - 环境变量传给 claude 子进程：`ANTHROPIC_BASE_URL`、`AUTH_TOKEN`
- ❌ 缺少 claude CLI：摘要流程直接降级失效，**仅入库可用**

**进程特征**：worker 会 spawn 子进程：
```
claude --model xxx --output-format stream-json --permission-mode dontAsk
```

```json
{
  "CLAUDE_MEM_PROVIDER": "claude",
  "CLAUDE_CODE_PATH": "/home/yourname/.npm-global/bin/claude",
  "ANTHROPIC_BASE_URL": "https://your-gateway.example.com/api/plan",
  "ANTHROPIC_AUTH_TOKEN": "<ark-token>"
}
```

### 模式 B：纯 LLM 直连模式（切换非 claude provider）
- ✅ 能力：直接 HTTP 调用兼容 OpenAI 接口模型做总结
- ✅ 依赖：**不需要安装 claude CLI**
- ✅ 适合搭配 OpenCode、自定义模型后端
- ⚠️ 限制：不再走 Claude Agent SDK 整套 agent 循环，没有内置工具、权限体系

```json
{
  "CLAUDE_MEM_PROVIDER": "openrouter",
  "CLAUDE_MEM_OPENROUTER_API_KEY": "<openrouter-key>",
  "CLAUDE_MEM_OPENROUTER_MODEL": "xiaomi/mimo-v2-flash:free",
  "CLAUDE_MEM_OPENROUTER_BASE_URL": ""
}
```
（worker 源码确认可选 provider 只有 `claude` / `openrouter` / `gemini`；
`CLAUDE_MEM_OPENROUTER_API_KEY` 也可从环境变量 `OPENROUTER_API_KEY` 读。）

---

## 3. 关键环境变量清单

| 变量 | 作用 | 注意事项 |
|---|---|---|
| `CLAUDE_MEM_PROVIDER` | 选择后端 | `claude` = 需要 CLI；`openrouter`/`gemini` 直连不需要 CLI |
| `CLAUDE_CODE_PATH` | 指定 claude 可执行路径 | PATH 找不到 claude 时必须配置，防止启动降级 |
| `ANTHROPIC_BASE_URL` | 上游接口地址 | 传给 claude 子进程，**worker 本身不直接用它发模型请求** |
| `AUTH_TOKEN` | 接口鉴权 | 由 claude CLI 读取，发给上游 LLM |

---

## 4. IDE Hook 说明（OpenCode 为例）

```bash
npx claude-mem install --ide opencode
```

1. 安装动作 = 注册 IDE 生命周期钩子（捕获会话、用户输入、工具返回）
2. Hook 只负责**抓上下文，投递到 worker:37701**
3. OpenCode 本身不承担总结、抽取工作，**不直接调用 LLM**

> **误区纠正**：claude-mem 名字带 "claude" ≠ 必须全程依赖 Claude 模型；
> 只是 `provider=claude` 这条分支绑定了 claude CLI 作为 agent runtime。

---

## 5. 常见故障现象 → 根因

| 现象 | 根因 |
|---|---|
| 队列可入、curl 查询正常，但不生成 observation / summary | Agent 链路降级，大概率**找不到 claude 可执行程序** |
| 日志 `Generator auto-starting (init) using Claude SDK` | 当前正在走**需要 spawn claude CLI** 的压缩分支 |
| 状态 `degraded=true` + `claude_cli setup_required` | worker 检测到**缺少 claude CLI 执行器**，不是缺 API / ARK 配置 |

另：日志 `SDK returned non-XML idle response — ignoring queued batch` 只是**首次重试被忽略**的正常现象——
worker 期望 `<observation>...</observation>` XML，第一次拿 idle 就重试，第二次通常拿到有效 XML 并落库
（随后日志 `STORED | obsCount=1`）。配好 `CLAUDE_CODE_PATH` 后链路即恢复，别误判为模型故障。

---

## 6. 部署避坑清单

**如果走 `CLAUDE_MEM_PROVIDER=claude`：**
- ✅ 预先装好 Claude Code CLI
- ✅ 校验 `which claude` 或配置 `CLAUDE_CODE_PATH`
- ✅ 环境变量需传递到子进程（`ANTHROPIC_BASE_URL`、`TOKEN`）

**如果不想维护 claude CLI：**
- ✅ 切换 provider 为 openai 兼容直连模式（`openrouter` / `gemini`）
- ✅ 不再启动 Agent SDK + claude 子进程链路

**排查优先看进程树**——观察 worker 是否 spawn 出 claude 子进程，是判断链路最直接证据：
```bash
PID=$(systemctl --user show claude-mem-worker -p MainPID --value)
pstree -p $PID
```

---

## 7. 最简选型一句话

- 需要内置 Agent 抽取、XML observation → `provider=claude`，**必须部署 claude CLI**
- 只需要简单上下文总结、不想额外维护 claude CLI → **OpenAI 兼容直连 provider**
