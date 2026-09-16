/**
 * Pi-Claude-Mem — claude-mem extension for pi-mono agents
 *
 * Gives pi-agents (pi-coding-agent, custom pi-mono runtimes) persistent
 * cross-session memory by connecting to the claude-mem worker HTTP API.
 *
 * Derived from the OpenClaw plugin (claude-mem/openclaw/src/index.ts) which
 * is a proven integration pattern for pi-mono-based runtimes.
 *
 * Install:
 *   pi install npm:pi-agent-memory
 *   — or —
 *   pi install git:github.com/thedotmack/claude-mem --extensions pi-agent/extensions
 *
 * Requires: claude-mem worker running on localhost:37777
 *
 * ---------------------------------------------------------------------------
 * Local patched build (2026-09-03)
 * Four compatibility fixes for claude-mem worker v13.18.0 + pi-agent-memory v0.3.4:
 *   1. FIX-1 port/host parsing accepts string form (original required number -> fallback to 37777)
 *   2. FIX-2 drop the /api/sessions/complete call (intentionally removed upstream in v12.4.4)
 *   3. FIX-3 /memory-status shows worker URL, port source and dependency degradation
 *   4. FIX-4 log the actual worker URL at startup to diagnose port mismatches
 * See DEBUG.md in the original repo for the debugging history
 * ---------------------------------------------------------------------------
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_WORKER_PORT = 37777;

/**
 * FIX-1: read claude-mem settings.json.
 *
 * The original did try/catch + JSON.parse separately in each discover function, with two problems:
 *   a) any comment (non-standard JSONC) made the whole parse fail -> silent fallback to defaults
 *   b) even on success, CLAUDE_MEM_WORKER_PORT is a **string** in the default config
 *      (e.g. "37701"), while the original check required typeof === "number" -> fallback to 37777
 * The extension then connected to 37777 while the worker listens on 37701, and /memory-status failed.
 *
 * Parse settings once here and accept both number and string forms.
 */
function readSettings(): Record<string, unknown> {
	const settingsDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), ".claude-mem");
	const settingsPath = join(settingsDir, "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
	} catch {
		// Invalid settings.json (e.g. // comments): degrade silently, never block startup
		console.warn(`[pi-claude-mem] failed to parse ${settingsPath}, using default worker address`);
		return {};
	}
}

const SETTINGS = readSettings();

/** Coerce a number or numeric string to a positive integer; return null if unparseable. */
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

/** FIX-3: record where the port came from for /memory-status diagnostics. */
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

async function workerPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
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

function workerPostFireAndForget(path: string, body: Record<string, unknown>): void {
	fetch(workerUrl(path), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[pi-claude-mem] Worker POST ${path} failed: ${message}`);
	});
}

async function workerGetText(path: string): Promise<string | null> {
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

// =============================================================================
// FIX-2: never POST /api/sessions/complete (aligns with upstream claude-mem architecture)
//
// The original called this endpoint 3s after agent_end to tell the worker to complete the session.
// The endpoint was intentionally removed upstream in claude-mem **v12.4.4 (2026-04-26)**:
//
//   CHANGELOG v12.4.4:
//   "This release removes the `SessionEnd → session-complete` hook entirely.
//    The worker self-completes via its SDK-agent generator's finally-block,
//    so no external completion call is needed."
//
// Reason: an external completion call fires when end signals (/clear, exit, logout) arrive and
// marks **pending observations in the queue as abandoned and drops them**, losing memories.
// The bug lurked for ~6 months from 2025-11-07, affecting Claude Code, Gemini CLI,
// the transcripts processor, the OpenCode plugin and OpenClaw.
//
// The official openclaw plugin removed scheduleSessionComplete / completionDelayMs /
// pendingCompletionTimers, keeping only init / observations / summarize.
// pi-agent-memory v0.3.4 is a pre-v12.4.4 fork, so the logic lingers here.
//
// Conclusion: the worker completes sessions itself; the extension must not notify completion.
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

	// FIX-4: log the actual worker URL and port source at startup.
	// Port mismatch is the most common failure; this log removes the guesswork.
	console.log(`[pi-claude-mem] worker -> ${workerUrl("")} (port from: ${PORT_SOURCE})`);

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
							text: `<pi-mem-context>\n${contextText}\n</pi-mem-context>`,
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
	// Summarize the session. await ensures the worker receives the request.
	//
	// FIX-2: no delayed /api/sessions/complete - the endpoint was removed in v12.4.4;
	// the worker completes the session itself in the SDK-agent generator's finally-block,
	// an external completion call would instead drop pending observations.
	//
	// Mirrors openclaw/src/index.ts lines 813-845 (completion part removed).
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

		// Await summarize - once received, the SDK-agent generator's finally-block
		// completes the session itself (including remaining observations). See FIX-2.
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
	// FIX-3: add worker URL, port source and dependency-degradation warnings.
	// Dependency degradation (e.g. missing claude CLI) skips all observations/summarize calls
	// and is the #1 cause of 'reachable but no memories'; surface it directly in status.
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
					const depText = deps?.degraded ? `\n⚠️ degraded dependencies: ${depNames || "unknown"}` : "";

					const ai = data.ai as { provider?: string } | undefined;
					const aiText = ai?.provider ? `\nAI provider: ${ai.provider}` : "";

					ctx.ui.notify(
						`pi-mem: connected to worker v${data.version || "?"} @ ${workerUrl("")} (port from: ${PORT_SOURCE})` +
							`\nsession: ${contentSessionId || "none"} | project: ${projectName}` +
							aiText +
							depText,
						"info",
					);
				} else {
					ctx.ui.notify(`pi-mem: worker returned HTTP ${response.status}`, "warning");
				}
			} catch {
				ctx.ui.notify(
					`pi-mem: worker unreachable ${workerUrl("/api/health")}` +
						`\nport from: ${PORT_SOURCE}` +
						`\ncheck the actual worker port, or set the CLAUDE_MEM_PORT env var`,
					"error",
				);
			} finally {
				clear();
			}
		},
	});
}
