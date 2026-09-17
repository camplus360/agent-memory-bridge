/**
 * pi-claude-mem — self-maintained claude-mem memory extension for pi-agents
 *
 * Gives pi-coding-agent (and other pi-mono runtimes) persistent cross-session
 * memory by talking to a locally running claude-mem worker over its HTTP API.
 *
 * This is a privately maintained fork, not an npm package. It derives from the
 * OpenClaw plugin (claude-mem/openclaw/src/index.ts) via the ArtemisAI
 * "pi-agent-memory" adapter (fork baseline v0.3.4). pi loads it as a local
 * path package from this repository. Provenance and the full change list are
 * documented in ../NOTICE; license: AGPL-3.0-or-later (see ../LICENSE).
 *
 * Install (local path package):
 *   pi install /absolute/path/to/pi-claude-mem
 *
 * Requires: a claude-mem worker reachable at CLAUDE_MEM_HOST:CLAUDE_MEM_PORT
 * (fallback 127.0.0.1:37777; host/port are also read from
 *  ~/.claude-mem/settings.json, so a worker installed with its default config
 *  is resolved correctly — this machine resolves to 127.0.0.1:37701).
 *
 * ---------------------------------------------------------------------------
 * 本维护版相对 fork 基线 pi-agent-memory@0.3.4 的修改（适配 worker v13.18.0）：
 *   1. FIX-1 端口/host 解析兼容字符串形态（原实现要求 number，导致 fallback 37777）
 *   2. FIX-2 移除 /api/sessions/complete 调用（该端点自 worker v12.4.4 起被移除）
 *   3. FIX-3 /memory-status 增加 worker 地址、端口来源、依赖降级等诊断信息
 *   4. FIX-4 启动时打印实际连接的 worker 地址，便于排查端口错配
 *   5. 注入上下文标签 <pi-mem-context> 正名为 <claude-mem-context>
 * 出处与完整修改清单见同目录 NOTICE。
 * ---------------------------------------------------------------------------
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_WORKER_PORT = 37777;

/**
 * FIX-1: 读取 claude-mem settings.json。
 *
 * 原实现在每个 discover 函数里各自 try/catch + JSON.parse，存在两个问题：
 *   a) settings.json 一旦含注释（非标准 JSONC）就整体解析失败 → 静默 fallback 默认值
 *   b) 即使解析成功，CLAUDE_MEM_WORKER_PORT 在 claude-mem 默认配置里是**字符串**
 *      （如 "37701"），而原判断要求 typeof === "number" → 同样 fallback 到 37777
 * 结果就是扩展连到 37777，而 worker 实际监听 37701，/memory-status 报不可达。
 *
 * 这里统一解析一次，并兼容 number / string 两种形态。
 */
function readSettings(): Record<string, unknown> {
	const settingsDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), ".claude-mem");
	const settingsPath = join(settingsDir, "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
	} catch {
		// settings.json 非法（如含 // 注释）时静默降级，不阻断启动
		console.warn(`[pi-claude-mem] 无法解析 ${settingsPath}，将使用默认 worker 地址`);
		return {};
	}
}

const SETTINGS = readSettings();

/** 把 number 或数字字符串统一成正整数，无法识别时返回 null */
function asPositiveInt(value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isInteger(parsed) && parsed > 0) return parsed;
	}
	return null;
}

function discoverWorkerHost(): string {
	if (process.env.CLAUDE_MEM_HOST) return process.env.CLAUDE_MEM_HOST;
	const host = SETTINGS.CLAUDE_MEM_WORKER_HOST;
	if (typeof host === "string" && host.trim() !== "") return host.trim();
	return "127.0.0.1";
}

function discoverWorkerPort(): number {
	const fromEnv = asPositiveInt(process.env.CLAUDE_MEM_PORT);
	if (fromEnv !== null) return fromEnv;

	const fromSettings = asPositiveInt(SETTINGS.CLAUDE_MEM_WORKER_PORT);
	if (fromSettings !== null) return fromSettings;

	return DEFAULT_WORKER_PORT;
}

/** FIX-3: 记录端口来源，便于 /memory-status 排查"为什么连到这个端口" */
function describePortSource(): string {
	if (asPositiveInt(process.env.CLAUDE_MEM_PORT) !== null) return "env:CLAUDE_MEM_PORT";
	if (asPositiveInt(SETTINGS.CLAUDE_MEM_WORKER_PORT) !== null) return "settings.json";
	return `default(${DEFAULT_WORKER_PORT})`;
}

const WORKER_PORT = discoverWorkerPort();
const WORKER_HOST = discoverWorkerHost();
const PORT_SOURCE = describePortSource();
const PLATFORM_SOURCE = "pi-agent";
const MAX_TOOL_RESPONSE_LENGTH = 1000;
const WORKER_FETCH_TIMEOUT_MS = 10_000;

// ---- Transport: unified claude-mem-worker.py vs in-process fetch ------------
// CLAUDE_MEM_TRANSPORT=py (default): every worker call is proxied through the
//   unified claude-mem-worker.py `api` passthrough (spawned), i.e. pi -> .py -> worker.
// CLAUDE_MEM_TRANSPORT=http: force the original direct-fetch path.
// If the .py shim is missing / exits non-zero / cannot reach the worker, the call
// transparently falls back to direct fetch, so this extension (the memory
// lifeline) is never broken by the migration. Override path with CLAUDE_MEM_WORKER_PY.
const TRANSPORT = (process.env.CLAUDE_MEM_TRANSPORT || "py").toLowerCase();
const WORKER_PY =
	process.env.CLAUDE_MEM_WORKER_PY ||
	`${homedir()}/.local/share/claude-mem/claude-mem-worker.py`;

// Invoke the .py shim once. Resolves { text } on delivery (exit 0), else null
// (no interpreter/script, timeout, or worker unreachable -> non-zero exit).
function callWorkerPy(
	method: "POST" | "GET",
	path: string,
	body?: Record<string, unknown>,
): Promise<{ text: string } | null> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("python3", [WORKER_PY, "api", method, path], {
				stdio: ["pipe", "pipe", "ignore"],
			});
		} catch {
			resolve(null);
			return;
		}
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (v: { text: string } | null) => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			finish(null);
		}, WORKER_FETCH_TIMEOUT_MS + 5000);
		child.stdout.on("data", (d: Buffer) => chunks.push(d));
		child.on("error", () => {
			clearTimeout(timer);
			finish(null);
		});
		child.on("close", (code: number | null) => {
			clearTimeout(timer);
			finish(code === 0 ? { text: Buffer.concat(chunks).toString("utf8") } : null);
		});
		try {
			if (method === "POST" && body !== undefined) {
				child.stdin.end(Buffer.from(JSON.stringify(body), "utf8"));
			} else {
				child.stdin.end();
			}
		} catch {
			clearTimeout(timer);
			finish(null);
		}
	});
}
const MAX_SEARCH_LIMIT = 100;

// =============================================================================
// HTTP Helpers
//
// Mirrors the pattern from openclaw/src/index.ts (lines 267-340).
// Three variants: awaited POST, fire-and-forget POST, awaited GET.
// All awaited calls use AbortController for timeout protection.
// =============================================================================

function workerUrl(path: string): string {
	return `http://${WORKER_HOST}:${WORKER_PORT}${path}`;
}

/** Create an AbortController that auto-aborts after the configured timeout. */
function createTimeoutController(): { controller: AbortController; clear: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), WORKER_FETCH_TIMEOUT_MS);
	return { controller, clear: () => clearTimeout(timer) };
}

async function workerPostHttp(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
	const { controller, clear } = createTimeoutController();
	try {
		const response = await fetch(workerUrl(path), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			console.error(`[pi-claude-mem] Worker POST ${path} returned ${response.status}`);
			return null;
		}
		return (await response.json()) as Record<string, unknown>;
	} catch (error: unknown) {
		if (error instanceof DOMException && error.name === "AbortError") {
			console.error(`[pi-claude-mem] Worker POST ${path} timed out after ${WORKER_FETCH_TIMEOUT_MS}ms`);
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[pi-claude-mem] Worker POST ${path} failed: ${message}`);
		return null;
	} finally {
		clear();
	}
}

function workerPostFireAndForgetHttp(path: string, body: Record<string, unknown>): void {
	fetch(workerUrl(path), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[pi-claude-mem] Worker POST ${path} failed: ${message}`);
	});
}

async function workerGetTextHttp(path: string): Promise<string | null> {
	const { controller, clear } = createTimeoutController();
	try {
		const response = await fetch(workerUrl(path), { signal: controller.signal });
		if (!response.ok) {
			console.error(`[pi-claude-mem] Worker GET ${path} returned ${response.status}`);
			return null;
		}
		return await response.text();
	} catch (error: unknown) {
		if (error instanceof DOMException && error.name === "AbortError") {
			console.error(`[pi-claude-mem] Worker GET ${path} timed out after ${WORKER_FETCH_TIMEOUT_MS}ms`);
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[pi-claude-mem] Worker GET ${path} failed: ${message}`);
		return null;
	} finally {
		clear();
	}
}

// Public transport: prefer the unified .py shim; fall back to direct fetch on any failure.
async function workerPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
	if (TRANSPORT === "py") {
		const r = await callWorkerPy("POST", path, body);
		if (r) {
			try {
				return r.text ? (JSON.parse(r.text) as Record<string, unknown>) : {};
			} catch {
				return {};
			}
		}
	}
	return workerPostHttp(path, body);
}

function workerPostFireAndForget(path: string, body: Record<string, unknown>): void {
	if (TRANSPORT === "py") {
		// The spawn itself is async; only fall back to fetch if the shim could not deliver.
		callWorkerPy("POST", path, body).then((r) => {
			if (!r) workerPostFireAndForgetHttp(path, body);
		});
		return;
	}
	workerPostFireAndForgetHttp(path, body);
}

async function workerGetText(path: string): Promise<string | null> {
	if (TRANSPORT === "py") {
		const r = await callWorkerPy("GET", path);
		if (r) return r.text;
	}
	return workerGetTextHttp(path);
}

// =============================================================================
// FIX-2: 不再发送 /api/sessions/complete（跟随 claude-mem 官方架构）
//
// 原实现在 agent_end 里延迟 3 秒调用该端点通知 worker 结束会话。
// 该端点已在 claude-mem **v12.4.4（2026-04-26）** 被官方有意移除：
//
//   CHANGELOG v12.4.4 原文：
//   "This release removes the `SessionEnd → session-complete` hook entirely.
//    The worker self-completes via its SDK-agent generator's finally-block,
//    so no external completion call is needed."
//
// 移除原因：外部完成调用会在会话结束信号（/clear、退出、登出）到达时，
// 把队列中**待处理的 observations 标记为 abandoned 并丢弃**，造成记忆丢失。
// 该问题自 2025-11-07 起潜伏约 6 个月，波及 Claude Code、Gemini CLI、
// transcripts processor、OpenCode plugin、OpenClaw 五个端。
//
// 官方 openclaw 插件已同步移除 scheduleSessionComplete / completionDelayMs /
// pendingCompletionTimers，仅保留 init / observations / summarize 三个调用。
// pi-agent-memory v0.3.4 是 v12.4.4 之前的 fork，故仍残留该逻辑。
//
// 结论：worker 自行完成会话，扩展端不应、也不必发送完成通知。
// =============================================================================

// =============================================================================
// Project Name Derivation
//
// Scopes observations by project. Uses PI_MEM_PROJECT env var if set,
// otherwise derives from the working directory basename with a "pi-" prefix.
// =============================================================================

function deriveProjectName(cwd: string): string {
	if (process.env.PI_MEM_PROJECT) {
		return process.env.PI_MEM_PROJECT;
	}
	const dir = basename(cwd);
	return `pi-${dir}`;
}

// =============================================================================
// Extension Factory
// =============================================================================

export default function piMemExtension(pi: ExtensionAPI) {
	// --- Extension state ---
	let contentSessionId: string | null = null;
	let projectName = "pi-agent";
	let sessionCwd = process.cwd();

	// Check kill switch
	if (process.env.PI_MEM_DISABLED === "1") {
		return;
	}

	// FIX-4: 启动时打印实际连接的 worker 地址与端口来源。
	// 端口错配是本扩展最常见的故障，有了这行日志无需猜测。
	console.log(`[pi-claude-mem] worker → ${workerUrl("")} (端口来源: ${PORT_SOURCE})`);

	// =========================================================================
	// Event: session_start
	//
	// Initialize local state only. The worker init happens in
	// before_agent_start (which has the user prompt). We set up the session ID
	// here so tool_result handlers have a target from the first turn.
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd;
		projectName = deriveProjectName(sessionCwd);
		contentSessionId = `pi-${projectName}-${Date.now()}`;

		// Persist session ID into the session file for compaction recovery
		pi.appendEntry("pi-mem-session", { contentSessionId, projectName });
	});

	// =========================================================================
	// Event: before_agent_start
	//
	// Initialize the session in the worker with the user's prompt.
	// The worker needs the prompt for privacy filtering — observations are
	// queued until a prompt is registered.
	//
	// Mirrors openclaw/src/index.ts lines 722-741.
	// =========================================================================

	pi.on("before_agent_start", async (event) => {
		if (!contentSessionId) return;

		await workerPost("/api/sessions/init", {
			contentSessionId,
			project: projectName,
			prompt: event.prompt || "pi-agent session",
			platformSource: PLATFORM_SOURCE,
		});

		return undefined;
	});

	// =========================================================================
	// Event: context
	//
	// Inject past observations into the LLM context. Calls the worker's
	// context injection endpoint which returns a formatted timeline of
	// relevant past work.
	//
	// Does NOT filter by platform_source so that pi-agents see observations
	// from Claude Code, Cursor, OpenClaw, etc. — enabling cross-engine memory.
	//
	// Mirrors openclaw/src/index.ts lines 743-759, but uses pi-mono's
	// ContextEventResult (returning messages array) instead of OpenClaw's
	// appendSystemContext.
	// =========================================================================

	pi.on("context", async (event) => {
		if (!contentSessionId) return;

		const projects = encodeURIComponent(projectName);
		const contextText = await workerGetText(`/api/context/inject?projects=${projects}`);

		if (!contextText || contextText.trim().length === 0) return;

		// Inject as a user message with XML tags to delineate memory context
		return {
			messages: [
				...event.messages,
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `<claude-mem-context>\n${contextText}\n</claude-mem-context>`,
						},
					],
				},
			],
		};
	});

	// =========================================================================
	// Event: tool_result
	//
	// Capture tool observations. Fire-and-forget to avoid slowing down the
	// agent loop. Skips memory_recall to prevent recursive observation loops.
	//
	// Mirrors openclaw/src/index.ts lines 764-808.
	// =========================================================================

	pi.on("tool_result", (event) => {
		if (!contentSessionId) return;

		const toolName = event.toolName;
		if (!toolName) return;

		// Skip memory tools to prevent recursive observation loops
		if (toolName === "memory_recall") return;

		// Extract result text from content blocks
		let toolResponseText = "";
		if (Array.isArray(event.content)) {
			toolResponseText = event.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
				.map((block) => block.text)
				.join("\n");
		}

		// Truncate to prevent oversized payloads
		if (toolResponseText.length > MAX_TOOL_RESPONSE_LENGTH) {
			toolResponseText = toolResponseText.slice(0, MAX_TOOL_RESPONSE_LENGTH - 12) + " [truncated]";
		}

		workerPostFireAndForget("/api/sessions/observations", {
			contentSessionId,
			tool_name: toolName,
			tool_input: event.input || {},
			tool_response: toolResponseText,
			cwd: sessionCwd,
			platformSource: PLATFORM_SOURCE,
		});

		return undefined;
	});

	// =========================================================================
	// Event: agent_end
	//
	// Summarize the session. 使用 await 确保 worker 收到请求。
	//
	// FIX-2: 不再延迟发送 /api/sessions/complete —— 该端点自 v12.4.4 起已被移除，
	// worker 在 SDK-agent generator 的 finally-block 中自行完成会话，
	// 外部完成调用反而会丢弃队列中待处理的 observations。
	//
	// Mirrors openclaw/src/index.ts lines 813-845（移除 completion 部分）。
	// =========================================================================

	pi.on("agent_end", async (event) => {
		if (!contentSessionId) return;

		// Extract last assistant message for summarization
		let lastAssistantMessage = "";
		if (Array.isArray(event.messages)) {
			for (let i = event.messages.length - 1; i >= 0; i--) {
				const msg = event.messages[i];
				if (msg?.role === "assistant") {
					if (typeof msg.content === "string") {
						lastAssistantMessage = msg.content;
					} else if (Array.isArray(msg.content)) {
						lastAssistantMessage = msg.content
							.filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
							.map((block) => block.text)
							.join("\n");
					}
					break;
				}
			}
		}

		// Await summarize —— worker 收到后由 SDK-agent generator 的 finally-block
		// 自行完成会话（含剩余 observations 的处理），无需外部完成通知。见 FIX-2。
		await workerPost("/api/sessions/summarize", {
			contentSessionId,
			last_assistant_message: lastAssistantMessage,
			platformSource: PLATFORM_SOURCE,
		});
	});

	// =========================================================================
	// Event: session_compact
	//
	// Preserve session state across context compaction. The LLM's context
	// window was trimmed, but our session continues — do NOT create a new
	// session or re-init the worker.
	//
	// Mirrors openclaw/src/index.ts lines 714-717.
	// =========================================================================

	pi.on("session_compact", () => {
		// Nothing to do — contentSessionId persists in extension state.
		// Re-injection happens automatically via the next `context` event.
	});

	// =========================================================================
	// Event: session_shutdown
	//
	// Clean up local state on process exit.
	// =========================================================================

	pi.on("session_shutdown", () => {
		contentSessionId = null;
	});

	// =========================================================================
	// Tool: memory_recall
	//
	// Registered tool that lets the LLM explicitly search past work sessions.
	// Uses the worker's search API (hybrid FTS5 + Chroma).
	// Does NOT filter by platform_source — returns results from all engines.
	// =========================================================================

	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"Search past work sessions for relevant context. Use when the user asks about previous work, or when you need context about how something was done before.",
		parameters: Type.Object({
			query: Type.String({ description: "Natural language search query" }),
			limit: Type.Optional(Type.Number({ description: "Max results to return (default: 5, max: 100)" })),
		}),

		async execute(_toolCallId, params) {
			const query = encodeURIComponent(String(params.query));
			const limit = Math.max(1, Math.min(typeof params.limit === "number" ? Math.floor(params.limit) : 5, MAX_SEARCH_LIMIT));
			const project = encodeURIComponent(projectName);

			const result = await workerGetText(`/api/search?query=${query}&limit=${limit}&project=${project}`);

			const text = result || "No matching memories found.";
			return {
				content: [{ type: "text" as const, text }],
				details: undefined,
			};
		},
	});

	// =========================================================================
	// Command: /memory-status
	//
	// Quick health check — verifies the worker is reachable and shows
	// current session state.
	//
	// FIX-3: 增加 worker 地址、端口来源、依赖降级告警。
	// 依赖降级（如 claude CLI 缺失）会让 observations/summarize 全部被跳过，
	// 是"连得上却没记忆"的头号原因，必须在状态里直接暴露。
	// =========================================================================

	pi.registerCommand("memory-status", {
		description: "Show pi-mem connection status and current session info",
		handler: async (_args, ctx) => {
			const { controller, clear } = createTimeoutController();
			try {
				const response = await fetch(workerUrl("/api/health"), { signal: controller.signal });
				if (response.ok) {
					const data = (await response.json()) as Record<string, unknown>;

					const deps = data.dependencies as
						| { degraded?: boolean; statuses?: Array<{ dependency?: string; kind?: string }> }
						| undefined;
					const depNames = (deps?.statuses ?? [])
						.map((s) => s.dependency)
						.filter((n): n is string => Boolean(n))
						.join(", ");
					const depText = deps?.degraded ? `\n⚠️ 依赖降级: ${depNames || "unknown"}` : "";

					const ai = data.ai as { provider?: string } | undefined;
					const aiText = ai?.provider ? `\nAI provider: ${ai.provider}` : "";

					ctx.ui.notify(
						`pi-mem: 已连接 worker v${data.version || "?"} @ ${workerUrl("")} (端口来源: ${PORT_SOURCE})` +
							`\n会话: ${contentSessionId || "none"} | 项目: ${projectName}` +
							aiText +
							depText,
						"info",
					);
				} else {
					ctx.ui.notify(`pi-mem: worker returned HTTP ${response.status}`, "warning");
				}
			} catch {
				ctx.ui.notify(
					`pi-mem: worker 不可达 ${workerUrl("/api/health")}` +
						`\n端口来源: ${PORT_SOURCE}` +
						`\n请核对 worker 实际端口，或设置环境变量 CLAUDE_MEM_PORT`,
					"error",
				);
			} finally {
				clear();
			}
		},
	});
}
