// opencode-claude-mem: capture-only plugin for claude-mem.
//
// Responsibility (capture and send only; no summarization):
//   - tool.execute.after      -> POST /api/sessions/observations (tool calls)
//   - chat.message (assistant)-> POST /api/sessions/observations (assistant replies)
//   - session.idle            -> POST /api/sessions/summarize    (worker summarizes)
//   - session.deleted         -> clear local session maps
//   - tool.claude_mem_search  -> GET  /api/search/observations   (recall)
//
// Summarization, embedding and vector search all happen in the claude-mem worker (127.0.0.1:37701).
// Zero dependencies; pure Node/Bun built-in fetch.

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 37701;
const MAX_RESPONSE_CHARS = 1000;
const MAX_SESSIONS_TRACKED = 1000;
const TOAST_DONE_MS = 4000;
const TOAST_ERROR_MS = 5000;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120000;

function workerBase() {
  const host = process.env.CLAUDE_MEM_WORKER_HOST || DEFAULT_HOST;
  const port = Number(process.env.CLAUDE_MEM_WORKER_PORT || DEFAULT_PORT);
  return `http://${host}:${port}`;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

// Exponential-backoff retries: transient worker hiccups / OpenRouter rate limits can fail a POST;
// a one-shot request would lose observations. Up to 3 tries (2s / 4s / 8s).
const POST_MAX_RETRIES = 3;
const POST_BACKOFF_MS = [2000, 4000, 8000];

async function workerPost(path, body, attempt = 0) {
  // Always tag the source as opencode, otherwise the worker defaults it to claude and source stats are wrong.
  const payload = body && typeof body === "object" && !body.platformSource
    ? { ...body, platformSource: "opencode" }
    : body;
  try {
    const res = await fetch(`${workerBase()}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`worker returned ${res.status}`);
    }
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("ECONNREFUSED")) {
      // Worker not running: give up immediately, no retry (avoids spinning)
      return false;
    }
    if (attempt < POST_MAX_RETRIES - 1) {
      console.warn(
        `[claude-mem] Worker POST ${path} failed (attempt ${attempt + 1}): ${msg} — retrying`
      );
      await new Promise((r) => setTimeout(r, POST_BACKOFF_MS[attempt] ?? 8000));
      return workerPost(path, payload, attempt + 1);
    }
    console.warn(`[claude-mem] Worker POST ${path} failed: ${msg}`);
    return false;
  }
}

async function workerGet(path) {
  try {
    const res = await fetch(`${workerBase()}${path}`, { headers: JSON_HEADERS });
    if (!res.ok) {
      console.warn(`[claude-mem] Worker GET ${path} returned ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker GET ${path} failed: ${msg}`);
    }
    return null;
  }
}

// opencode sessionID -> claude-mem contentSessionId (matches the official shim)
const sessionIdMap = new Map();
const initializedSessions = new Set();
// opencode sessionID -> latest assistant text, passed as last_assistant_message on summarize
const assistantLastMessage = new Map();
// opencode messageID -> role of that message ("user" / "assistant"), used to filter user text parts
const messageRoles = new Map();
// opencode sessionID -> Map<messageID, Map<partID, text>>: streamed-but-not-yet-stored assistant text
const assistantText = new Map();

// Record one assistant text part. The same part is pushed repeatedly (delta -> complete);
// keyed by partID we overwrite, keeping the final complete text.
function recordAssistantText(sessionId, messageId, partId, text) {
  if (!sessionId || !messageId || !text) return;
  let byMessage = assistantText.get(sessionId);
  if (!byMessage) {
    byMessage = new Map();
    assistantText.set(sessionId, byMessage);
  }
  let byPart = byMessage.get(messageId);
  if (!byPart) {
    byPart = new Map();
    byMessage.set(messageId, byPart);
  }
  byPart.set(partId ?? `part-${byPart.size}`, text);
}

// Take (and remove) the complete text of an assistant message; empty string if already taken.
function takeAssistantText(sessionId, messageId) {
  const byMessage = assistantText.get(sessionId);
  const byPart = byMessage?.get(messageId);
  if (!byPart || byPart.size === 0) return "";
  byMessage.delete(messageId);
  return [...byPart.values()].join("\n").trim();
}

function contentSessionId(opencodeSessionId) {
  let id = sessionIdMap.get(opencodeSessionId);
  if (!id) {
    if (sessionIdMap.size >= MAX_SESSIONS_TRACKED) {
      const oldest = sessionIdMap.keys().next().value;
      if (oldest !== undefined) {
        sessionIdMap.delete(oldest);
        initializedSessions.delete(oldest);
        assistantLastMessage.delete(oldest);
        assistantText.delete(oldest);
      }
    }
    id = `opencode-${opencodeSessionId}-${Date.now()}`;
    sessionIdMap.set(opencodeSessionId, id);
  }
  return id;
}

function ensureSession(opencodeSessionId, project) {
  // Only resolve/generate the contentSessionId; never send an empty init. The real init (with the
  // user prompt) fires from the user branch of chat.message, avoiding an empty "[media prompt]" fallback.
  return contentSessionId(opencodeSessionId);
}

function truncate(text) {
  return text.length > MAX_RESPONSE_CHARS
    ? text.slice(0, MAX_RESPONSE_CHARS)
    : text;
}

// opencode tui.showToast accepts { title, description, variant?, duration? }.
// Also tolerate the { title, message, ... } shape; silent when the TUI is unavailable.
async function toast(ctx, body) {
  const payload = {
    title: body.title ?? body.message ?? "claude-mem",
    description: body.description ?? body.message ?? "",
    variant: body.variant ?? "success",
    duration: body.duration ?? TOAST_DONE_MS,
  };
  try {
    await ctx?.client?.tui?.showToast?.(payload);
  } catch {
    // Silent when the TUI is unavailable (e.g. headless / test environments)
  }
}

async function getStats() {
  const text = await workerGet("/api/stats");
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return data?.database ?? null;
  } catch {
    return null;
  }
}

// After idle, poll stats until the worker writes the summary, then show a visible toast
const watchingSessions = new Set();
// Never trigger summarize twice for one session while a poll is in flight
const summarizeInflight = new Set();

function watchSummary(ctx, sessionId, baselineSummaries, baselineObservations) {
  if (watchingSessions.has(sessionId)) return;
  watchingSessions.add(sessionId);
  const started = Date.now();
  const finish = () => watchingSessions.delete(sessionId);
  const tick = async () => {
    const db = await getStats();
    if (!db) {
      if (Date.now() - started < POLL_TIMEOUT_MS) {
        setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }
      await toast(ctx, {
        title: "claude-mem not responding",
        message: "Cannot reach the worker; the memory summary may not have completed (systemctl --user status claude-mem-worker)",
        variant: "error",
        duration: TOAST_ERROR_MS,
      });
      finish();
      return;
    }

    const newSummaries = (db.summaries ?? 0) - baselineSummaries;
    const newObservations = (db.observations ?? 0) - baselineObservations;

    if (newSummaries > 0) {
      await toast(ctx, {
        title: "Memory saved (claude-mem)",
        description: `This turn was summarized and stored (+${newSummaries} summary${newSummaries > 1 ? "ies" : ""}${newObservations > 0 ? ` / +${newObservations} observation(s)` : ""}, ${db.summaries} total)`,
        variant: "success",
        duration: TOAST_DONE_MS,
      });
      finish();
      return;
    }

    if (Date.now() - started < POLL_TIMEOUT_MS) {
      setTimeout(tick, POLL_INTERVAL_MS);
    } else {
      finish();
    }
  };
  setTimeout(tick, POLL_INTERVAL_MS);
}

// Minimal zod-compatible shim: the opencode plugin SDK describes tool args with zod schemas.
// Implement only the interface string() needs to avoid a dependency.
function zodString() {
  const schema = {
    _def: { typeName: "ZodString" },
    isOptional: false,
    description: undefined,
    describe(text) {
      this.description = text;
      return this;
    },
    optional() {
      this.isOptional = true;
      return this;
    },
    safeParse(value) {
      if (typeof value === "string") return { success: true, data: value };
      if (value === undefined && this.isOptional) return { success: true, data: undefined };
      return { success: false, error: new Error("expected string") };
    },
    parse(value) {
      const result = this.safeParse(value);
      if (!result.success) throw result.error;
      return result.data;
    },
  };
  return schema;
}

function parseSearchResponse(raw, query) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.warn(
      "[claude-mem] Failed to parse search results:",
      error instanceof Error ? error.message : String(error)
    );
    return "Failed to parse search results.";
  }
  const content = data.content;
  if (!Array.isArray(content) || content.length === 0) {
    return `No results found for "${query}".`;
  }
  const text = content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || `No results found for "${query}".`;
}

export const ClaudeMemCapturePlugin = async (ctx) => {
  const project = ctx?.project?.name || "opencode";
  const directory = ctx?.directory || process.cwd();

  console.log(`[claude-mem] capture plugin loading (project: ${project}, worker: ${workerBase()})`);

  // Store one assistant reply: POST a chat.message observation + update the last_assistant_message cache.
  async function flushAssistantMessage(opencodeSessionId, messageId) {
    const text = takeAssistantText(opencodeSessionId, messageId);
    if (!text) return;
    assistantLastMessage.set(opencodeSessionId, text);
    await workerPost("/api/sessions/observations", {
      contentSessionId: contentSessionId(opencodeSessionId),
      tool_name: "chat.message",
      tool_input: {},
      tool_response: truncate(text),
      cwd: directory,
    });
  }

  // Fallback: flush all not-yet-stored assistant text for the session (in message order).
  // Called before summarize to guarantee last_assistant_message is non-empty.
  async function flushPendingAssistant(opencodeSessionId) {
    const byMessage = assistantText.get(opencodeSessionId);
    if (!byMessage || byMessage.size === 0) return;
    for (const messageId of [...byMessage.keys()]) {
      await flushAssistantMessage(opencodeSessionId, messageId);
    }
  }

  return {
    "tool.execute.after": async (input, output) => {
      const session = ensureSession(input.sessionID, project);
      const raw = output?.output;
      // Tool results can be objects (e.g. {content:[...]}); stringify them instead of [object Object]
      const respText =
        typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
      await workerPost("/api/sessions/observations", {
        contentSessionId: session,
        tool_name: input.tool,
        tool_input: input?.args || {},
        tool_response: truncate(respText),
        cwd: directory,
      });
    },

    // opencode chat.message trigger: input = {sessionID, agent, model, messageID, variant},
    // output = {message, parts}. sessionID is on input (first arg), not on output.message.
    //
    // Note (observed on opencode 1.18.x): chat.message fires only when a **user message** is enqueued;
    // the binary has no assistant-side trigger, so output.message.role is always "user".
    // Assistant replies are captured via experimental.text.complete + message.part.updated (below).
    "chat.message": async (input, output) => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;
      const text = (output?.parts || [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      if (!text) return;
      const role = output?.message?.role || input?.role;
      if (role === "user") {
        // User prompt: init WITH the prompt creates the session and writes user_prompts (same as pi);
        // never use prompt:"" or it falls back to "[media prompt]".
        const csid = contentSessionId(sessionId);
        initializedSessions.add(sessionId);
        await workerPost("/api/sessions/init", {
          contentSessionId: csid,
          project,
          prompt: truncate(text),
        });
        return;
      }
      // If opencode ever adds assistant-side chat.message, route it through the same path to avoid duplicates.
      messageRoles.set(output?.message?.id, "assistant");
      recordAssistantText(sessionId, output?.message?.id, null, text);
    },

    // One assistant text part finished streaming: input = {sessionID, messageID, partID},
    // output = {text}. This is the most reliable source of assistant text.
    "experimental.text.complete": async (input, output) => {
      const text = output?.text;
      if (typeof text !== "string" || !text.trim()) return;
      const messageId = input?.messageID;
      if (messageId) messageRoles.set(messageId, "assistant");
      recordAssistantText(input?.sessionID, messageId, input?.partID, text);
    },

    "experimental.session.compacting": async (input) => {
      await flushPendingAssistant(input.sessionID);
      const session = ensureSession(input.sessionID, project);
      await workerPost("/api/sessions/summarize", {
        contentSessionId: session,
        last_assistant_message: assistantLastMessage.get(input.sessionID) ?? "",
      });
    },

    event: async ({ event }) => {
      const type = event?.type;
      const props = event?.properties ?? {};
      const part = props.part;
      const info = props.info;
      const sessionId =
        props.sessionID ?? info?.sessionID ?? info?.id ?? part?.sessionID;
      if (!sessionId) return;

      switch (type) {
        // Track each message role to exclude text parts belonging to user messages
        case "message.updated": {
          const role = info?.role;
          if (info?.id && role) messageRoles.set(info.id, role);
          // time.completed on an assistant message means the reply is fully done -> store it
          if (role === "assistant" && info?.time?.completed) {
            await flushAssistantMessage(sessionId, info.id);
          }
          break;
        }
        case "message.part.updated": {
          if (part?.type !== "text" || typeof part.text !== "string") break;
          // Take only when the part is complete (time.end present); part.text is then full, not a delta
          if (!part.time?.end) break;
          if (messageRoles.get(part.messageID) === "user") break;
          recordAssistantText(sessionId, part.messageID, part.id, part.text);
          break;
        }
        case "session.idle": {
          // Dedupe: do not trigger summarize again for a session while a poll is in flight;
          // avoids duplicate summaries / worker queue buildup from repeated idle events.
          if (summarizeInflight.has(sessionId)) break;
          summarizeInflight.add(sessionId);

          // Flush pending assistant text first, then summarize;
          // otherwise last_assistant_message is empty -> worker reports Missing last_assistant_message.
          await flushPendingAssistant(sessionId);

          const session = ensureSession(sessionId, project);
          const before = await getStats();
          const baselineSummaries = before?.summaries ?? 0;
          const baselineObservations = before?.observations ?? 0;
          const ok = await workerPost("/api/sessions/summarize", {
            contentSessionId: session,
            last_assistant_message: assistantLastMessage.get(sessionId) ?? "",
          });
          if (ok) {
            watchSummary(ctx, sessionId, baselineSummaries, baselineObservations);
          } else {
            summarizeInflight.delete(sessionId);
            await toast(ctx, {
              title: "claude-mem worker not running",
              description: "Memory capture skipped: systemctl --user start claude-mem-worker",
              variant: "error",
              duration: TOAST_ERROR_MS,
            });
          }
          break;
        }
        case "session.deleted": {
          sessionIdMap.delete(sessionId);
          initializedSessions.delete(sessionId);
          assistantLastMessage.delete(sessionId);
          assistantText.delete(sessionId);
          summarizeInflight.delete(sessionId);
          break;
        }
        default:
          break;
      }
    },

    tool: {
      claude_mem_search: {
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: zodString().describe("Search query for memory observations"),
        },
        async execute(args) {
          const query = String(args?.query || "");
          if (!query) return "Please provide a search query.";
          const raw = await workerGet(
            `/api/search/observations?query=${encodeURIComponent(query)}&limit=10`
          );
          return raw
            ? parseSearchResponse(raw, query)
            : "claude-mem worker is not running. Start it with: systemctl --user start claude-mem-worker";
        },
      },
    },
  };
};

// Align with the official opencode-mem plugin (the PluginModule contract of @opencode-ai/plugin):
// default export { id, server }; the opencode loader takes the plugin factory from default.server.
export default { id: "opencode-claude-mem", server: ClaudeMemCapturePlugin };
