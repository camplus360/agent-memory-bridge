// SPDX-License-Identifier: MIT
// Copyright (c) 2026 camplus <camplus360@163.com>
//
// dsh-agent-memory-bridge — capture-only memory adapter for DeepSeek Harness (dsh).
//
// Independent implementation written against:
//   - the installed dsh 0.1.1-rc.2 plugin/event/tool contract (real source, not guessed)
//   - the claude-mem worker HTTP protocol (same contract as ../opencode, ../pi)
//
// Responsibility — capture and send ONLY; no summarization/embedding/search locally:
//   session/event firehose (ctx.on("session/event", (session, event) => ...),
//   where event = { type, seq, time, data }):
//     turn/start       -> local session state (worker init is deferred to the first
//                         real user/message so we never POST an empty prompt)
//     user/message      -> POST /api/sessions/init   (once, carries the real prompt)
//     assistant/message -> POST /api/sessions/observations (assistant reply text)
//     tool/call          -> cache { name, arguments } keyed by callId
//     tool/result        -> POST /api/sessions/observations (tool result text)
//     turn/end          -> POST /api/sessions/summarize (worker summarizes/embeds)
//   agent/pre-step waterfall -> GET /api/context/inject, returned as an extra
//                         { kind: "enter", messages } decision (cross-engine memory)
//   tool "memory_recall"   -> GET /api/search (hybrid FTS5 + vector search in worker)
//
// Every POST is tagged platformSource: "dsh" so source attribution is correct.
// Summarization, embeddings and vector search all run inside the claude-mem worker
// (default http://127.0.0.1:37701). Zero runtime dependencies — Node built-in
// fetch/crypto only (node:crypto is a built-in module, not an npm dependency).

"use strict";

import { randomUUID } from "node:crypto";

const PLUGIN_NAME = "dsh-agent-memory-bridge";
const PLATFORM_SOURCE = "dsh";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 37701;

const MAX_OBSERVATION_CHARS = 4000; // tool/assistant payload cap sent to the worker
const FETCH_TIMEOUT_MS = 10_000;
const MAX_SEARCH_LIMIT = 100;

// Exponential backoff for transient worker hiccups: 0.5s, 1s, 2s, 4s (4 tries).
const POST_MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 500;

// ---------------------------------------------------------------------------
// Configuration. Environment is primary (matches CLAUDE_MEM_HOST/PORT); the
// Cordis plugin `config` object, when provided, can override it.
// ---------------------------------------------------------------------------

function positiveInt(value, fallback) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return fallback;
}

function resolveConfig(config = {}) {
  const host =
    config.host ||
    process.env.CLAUDE_MEM_HOST ||
    process.env.CLAUDE_MEM_WORKER_HOST ||
    DEFAULT_HOST;
  const port = positiveInt(
    config.port ?? process.env.CLAUDE_MEM_PORT ?? process.env.CLAUDE_MEM_WORKER_PORT,
    DEFAULT_PORT
  );
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    // Kill switch, mirroring the other adapters.
    disabled: process.env.DSH_MEM_DISABLED === "1" || config.disabled === true,
  };
}

// ---------------------------------------------------------------------------
// HTTP transport (built-in fetch, AbortController timeout, exponential backoff)
// ---------------------------------------------------------------------------

function withTimeout(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("worker request timeout")), ms);
  const onAbort = () => controller.abort(signal?.reason ?? new Error("aborted"));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnRefused(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("ECONNREFUSED") || msg.includes("fetch failed");
}

function createTransport(cfg) {
  const log = (msg) => console.warn(`[${PLUGIN_NAME}] ${msg}`);

  async function postJson(path, body, attempt = 0) {
    const { signal, cleanup } = withTimeout(undefined, FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${cfg.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(`worker POST ${path} returned ${res.status}`);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Worker not running: don't spin retries; capture simply skips this event.
      if (isConnRefused(error) || (error instanceof DOMException && error.name === "AbortError")) {
        if (attempt === POST_MAX_RETRIES - 1) log(`${path} failed: ${msg}`);
      }
      if (attempt < POST_MAX_RETRIES - 1) {
        const wait = BACKOFF_BASE_MS * 2 ** attempt;
        if (attempt === 0) log(`${path} failed (attempt 1): ${msg} — retrying in ${wait}ms`);
        await sleep(wait);
        return postJson(path, body, attempt + 1);
      }
      log(`${path} gave up after ${POST_MAX_RETRIES} attempts: ${msg}`);
      return false;
    } finally {
      cleanup();
    }
  }

  async function getText(path) {
    const { signal, cleanup } = withTimeout(undefined, FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${cfg.baseUrl}${path}`, { signal });
      if (!res.ok) {
        log(`GET ${path} returned ${res.status}`);
        return null;
      }
      return await res.text();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!isConnRefused(error)) log(`GET ${path} failed: ${msg}`);
      return null;
    } finally {
      cleanup();
    }
  }

  // Always tag source so the worker never defaults it to another engine.
  function tagged(body) {
    return body && typeof body === "object" && body.platformSource === undefined
      ? { ...body, platformSource: PLATFORM_SOURCE }
      : body;
  }

  return {
    baseUrl: cfg.baseUrl,
    // Awaited POST (used for init/summarize where delivery ordering matters).
    post: (path, body) => postJson(path, tagged(body)),
    // Fire-and-forget POST for the high-frequency observation stream.
    postForget(path, body) {
      postJson(path, tagged(body)).catch(() => {});
    },
    get: getText,
  };
}

// ---------------------------------------------------------------------------
// Text / message projection helpers (dsh message shapes verified in source:
//   assistant/user message: { id, role, content: ContentBlock[], source }
//   tool-result block:      { type: "tool-result", toolCallId, content, isError }
// )
// ---------------------------------------------------------------------------

function truncate(text) {
  const str = String(text ?? "");
  return str.length > MAX_OBSERVATION_CHARS
    ? `${str.slice(0, MAX_OBSERVATION_CHARS - 14)} [truncated]`
    : str;
}

// Join visible text blocks of a dsh content array.
function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (typeof block === "string") parts.push(block);
  }
  return parts.join("\n").trim();
}

// A tool-result block carries its own nested `content` block array.
function textFromToolResult(message) {
  const block = message?.content?.find?.((b) => b?.type === "tool-result");
  if (!block) return "";
  const inner = textFromContent(block.content);
  if (inner) return inner;
  // Some adapters put a plain string / JSON in content.
  return typeof block.content === "string" ? block.content : "";
}

function deriveProject(cwd) {
  if (process.env.DSH_MEM_PROJECT) return process.env.DSH_MEM_PROJECT;
  const base = (cwd || process.cwd()).replace(/[\\/]+$/, "").split("/").pop() || "dsh";
  return `dsh-${base}`;
}

// ---------------------------------------------------------------------------
// Per-session capture state. Keyed by the live Session object (WeakMap) so a
// hot-reloaded/re-adopted session resumes without leaking. `seenSeqs` dedupes
// replayed events from the canonical log.
// ---------------------------------------------------------------------------

function createSessionStore() {
  const states = new WeakMap();

  function ensure(session, worker) {
    let state = states.get(session);
    if (!state) {
      const cwd = session?.header?.cwd || process.cwd();
      const project = deriveProject(cwd);
      state = {
        cwd,
        project,
        // Stable id namespaced to dsh + the harness session id.
        contentSessionId: `${PLATFORM_SOURCE}-${String(session?.id ?? "session")}-${Date.now()}`,
        initialized: false,
        lastAssistant: "",
        // callId -> { name, arguments } from tool/call; tool/result links via toolCallId.
        pendingCalls: new Map(),
        seenSeqs: new Set(),
        // turn number that already received injected context (once per turn).
        lastInjectedTurn: undefined,
        summarizeInflight: false,
      };
      states.set(session, state);
      void worker;
    }
    return state;
  }

  return { ensure };
}

// ---------------------------------------------------------------------------
// memory_recall tool (zero-dependency raw definition).
//
// ctx.tools.register requires output = { schema, render }; `parameters` is a
// native JSON Schema (defineTool only converts the authoring "spec" form).
// We wait for the tools service through ctx.inject(["tools"], ...), so no
// dsh package import and no npm dependency are needed.
// ---------------------------------------------------------------------------

function parseSearchResponse(raw, query) {
  if (raw == null) return null;
  // Worker shape used by the other adapters: { content: [{ type:"text", text }] }.
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data?.content)) {
      const text = data.content
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    if (typeof data === "string" && data.trim()) return data.trim();
  } catch {
    // Not JSON — the worker answered with plain text.
    if (raw.trim()) return raw.trim();
  }
  return `No results found for "${query}".`;
}

function registerMemoryRecallTool(ctx, store, worker) {
  const definition = {
    name: "memory_recall",
    description:
      "Search past work sessions across all agents for relevant context (claude-mem hybrid full-text + vector memory). Use when the user asks about previous work, or when you need to know how something was done before.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query, broad first then narrower.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: "Maximum results to return (default 5).",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, _exec) {
      const query = String(args?.query ?? "").trim();
      if (!query) return { text: "Please provide a search query." };
      const limit = Math.max(
        1,
        Math.min(Number.isInteger(args?.limit) ? args.limit : 5, MAX_SEARCH_LIMIT)
      );
      // Faithful proxy of the worker's hybrid search. The worker search is
      // cross-engine (Claude Code, pi, opencode, dsh, ...); project scoping is
      // left to the query unless explicitly appended by the caller.
      const qs = `/api/search?query=${encodeURIComponent(query)}&limit=${limit}`;
      const raw = await worker.get(qs);
      const text =
        parseSearchResponse(raw, query) ??
        "claude-mem worker is not reachable. Start it, then retry.";
      return { text };
    },
  };

  // Start only once the `tools` service exists (service-driven loading).
  // register() ties its own disposer to the injected fiber's scope; don't
  // re-return it (the fiber would treat it as a second cleanup effect).
  ctx.inject(["tools"], (ictx) => {
    ictx.tools.register(definition);
  });
}

// ---------------------------------------------------------------------------
// Context injection seam.
//
// dsh has no "context" event; the lifecycle doc states injected context goes
// through the agent/pre-step waterfall: a listener calls next() to get the
// downstream { kind, messages } decision and may return { kind:"enter",
// messages } to append a message. We inject once per turn, on its first step,
// wrapped in a plugin-sourced "recall" message (valid MessageSource kind).
// Any failure returns the original decision unchanged — memory must never break a turn.
// ---------------------------------------------------------------------------

function registerContextInjection(ctx, store, worker) {
  ctx.on(
    "agent/pre-step",
    async (payload, next) => {
      let decision;
      try {
        decision = await next();
      } catch (error) {
        throw error;
      }
      try {
        if (!decision || decision.kind === "reject" || !Array.isArray(decision.messages)) {
          return decision;
        }
        const session = payload?.agent?.session;
        if (!session) return decision;

        const state = store.ensure(session, worker);
        // Inject only on the first step of each turn.
        const step = payload?.step ?? 1;
        const turn = payload?.turn ?? 0;
        if (step !== 1 || state.lastInjectedTurn === turn) return decision;
        state.lastInjectedTurn = turn;

        const raw = await worker.get(
          `/api/context/inject?projects=${encodeURIComponent(state.project)}`
        );
        const contextText = (raw ?? "").trim();
        if (!contextText) return decision;

        // Zero-dependency plugin "recall" user message (id is just a branded string).
        const recallMessage = {
          id: randomUUID(),
          role: "user",
          content: [
            {
              type: "text",
              text: `<claude-mem-context>\n${contextText}\n</claude-mem-context>`,
            },
          ],
          source: { kind: "plugin", plugin: PLUGIN_NAME, form: "recall" },
        };
        Object.freeze(recallMessage);
        Object.freeze(recallMessage.content);
        Object.freeze(recallMessage.content[0]);

        return { kind: "enter", messages: [...decision.messages, recallMessage] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[${PLUGIN_NAME}] context injection failed: ${msg}`);
        return decision;
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Plugin factory. dsh loads `export default function` as a Cordis function
// plugin (loader unwrapExports takes module.default; Cordis.resolve accepts a
// bare function) and invokes it as (ctx, config).
// ---------------------------------------------------------------------------

export default function dshAgentMemoryBridge(ctx, config = {}) {
  const cfg = resolveConfig(config);
  if (cfg.disabled) return;

  const worker = createTransport(cfg);
  const store = createSessionStore();

  console.log(`[${PLUGIN_NAME}] loaded → claude-mem worker at ${worker.baseUrl}`);

  // ---- Canonical session firehose -----------------------------------------
  // Every durable lifecycle event arrives here as (session, event) with
  // event.type in: turn/start, user/message, assistant/message, tool/call,
  // tool/result, step/start, step/end, turn/end, ...
  ctx.on("session/event", (session, event) => {
    try {
      handleSessionEvent(session, event);
    } catch (error) {
      // cordis emit is stop-on-throw: never let capture starve other listeners.
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[${PLUGIN_NAME}] event handler failed: ${msg}`);
    }
  });

  function handleSessionEvent(session, event) {
    if (!session || !event || typeof event.type !== "string") return;
    const state = store.ensure(session, worker);

    // Dedupe replayed/adopted events (seq is unique within a session log).
    if (typeof event.seq === "number") {
      if (state.seenSeqs.has(event.seq)) return;
      state.seenSeqs.add(event.seq);
    }

    const data = event.data ?? {};

    switch (event.type) {
      case "turn/start":
        // Local state already created above. The worker session is initialized
        // by the first real user/message (below) so init carries a real prompt;
        // an empty prompt makes the worker fall back to "[media prompt]".
        break;

      case "user/message": {
        // Only a genuine human prompt initializes the worker session. Tool
        // results arrive as user-role messages with source.kind "tool" (captured
        // via tool/result), and this plugin's own agent/pre-step memory injection
        // is a durable user-role message with source.kind "plugin" — both must
        // NOT be used as the init prompt, otherwise the injected memory text gets
        // recorded as the user's first prompt (a capture feedback loop).
        if (data.source?.kind !== "user") break;
        const text = textFromContent(data.content);
        if (!text) break;
        if (!state.initialized) {
          state.initialized = true;
          // Fire-and-forget is wrong here: the first observation can reach the
          // worker before init creates the session. Keep init on the awaited
          // path (worker.post) so ordering is preserved.
          worker.post("/api/sessions/init", {
            contentSessionId: state.contentSessionId,
            project: state.project,
            prompt: truncate(text),
          });
        }
        break;
      }

      case "assistant/message": {
        const text = textFromContent(data.message?.content);
        if (!text) break;
        state.lastAssistant = truncate(text);
        worker.postForget("/api/sessions/observations", {
          contentSessionId: state.contentSessionId,
          tool_name: "assistant.message",
          tool_input: {},
          tool_response: state.lastAssistant,
          cwd: state.cwd,
        });
        break;
      }

      case "tool/call": {
        // data = { turn, step, callId, name, arguments } — `arguments` is the
        // raw JSON string exactly as the model produced it (unparsed). Parse
        // it for the worker's tool_input object; keep {} on any malformed JSON.
        if (typeof data.callId === "string" && typeof data.name === "string") {
          let parsedArgs = {};
          if (typeof data.arguments === "string" && data.arguments.trim() !== "") {
            try {
              const parsed = JSON.parse(data.arguments);
              if (parsed && typeof parsed === "object") parsedArgs = parsed;
            } catch {
              parsedArgs = { raw: data.arguments };
            }
          }
          state.pendingCalls.set(data.callId, { name: data.name, arguments: parsedArgs });
        }
        break;
      }

      case "tool/result": {
        // data = { turn, step, message } where message.content[0] is the tool-result.
        const toolBlock = data.message?.content?.find?.((b) => b?.type === "tool-result");
        const callId = toolBlock?.toolCallId;
        const call = (callId && state.pendingCalls.get(callId)) || {};
        const toolName = call.name || "unknown.tool";

        // Never record memory_recall itself: prevents an observation feedback loop.
        if (toolName === "memory_recall") {
          if (callId) state.pendingCalls.delete(callId);
          break;
        }

        const responseText = textFromToolResult(data.message);
        worker.postForget("/api/sessions/observations", {
          contentSessionId: state.contentSessionId,
          tool_name: toolName,
          tool_input: call.arguments ?? {},
          tool_response: truncate(responseText),
          cwd: state.cwd,
        });
        if (callId) state.pendingCalls.delete(callId);
        break;
      }

      case "turn/end": {
        // dsh has no single process-level "agent end"; a turn is the natural
        // unit of work, so ask the worker to summarize/embed once per turn.
        // Skip until a real session was initialized (an empty/rejected turn
        // produces nothing to summarize) and dedupe concurrent triggers.
        if (!state.initialized || state.summarizeInflight) break;
        state.summarizeInflight = true;
        worker
          .post("/api/sessions/summarize", {
            contentSessionId: state.contentSessionId,
            last_assistant_message: state.lastAssistant ?? "",
          })
          .finally(() => {
            state.summarizeInflight = false;
          });
        break;
      }

      default:
        // step/start, step/end, assistant/chunk, etc. are intentionally ignored.
        break;
    }
  }

  // ---- Cross-session memory injection + explicit recall tool ---------------
  registerContextInjection(ctx, store, worker);
  registerMemoryRecallTool(ctx, store, worker);

  // Per-session state is held in a WeakMap keyed by the live Session objects,
  // so it is collected when the sessions go; the ctx.on/ctx.inject registrations
  // are fiber-scoped and unwind automatically when this plugin unloads.
}
