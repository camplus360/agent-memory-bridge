// Mocked tests for the opencode-claude-mem capture plugin.
// Run: bun test index.test.js   (or: node index.test.js)
//
// These are transport-level unit tests: they assert the event -> endpoint
// mapping (init/observation/summarize), dedupe and retry against a fetch mock,
// so they pin the mockable in-process HTTP transport. The production default is
// the spawned claude-mem-worker.py shim (CLAUDE_MEM_TRANSPORT=py), which is
// covered by real E2E; force http here so every request goes through the mock.
// This MUST be set before the dynamic import() below (TRANSPORT is read once at
// module load).
process.env.CLAUDE_MEM_TRANSPORT = "http";

let served = []; // {method, path, body}
let toastCalls = [];

// Worker behaviour switches: 200 by default; inject failure counts as needed.
let failNext = 0; // next N non-ECONNREFUSED calls fail
let connRefused = false;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  let body = opts?.body ? JSON.parse(opts.body) : undefined;

  if (connRefused) {
    // Connection refused: record nothing (worker down; the plugin must give up).
    throw new Error("fetch failed: ECONNREFUSED");
  }
  served.push({ method: opts?.method ?? "GET", path: u, body });
  if (failNext > 0) {
    failNext -= 1;
    served.push({ failed: true });
    return new Response("boom", { status: 500 });
  }
  // /api/stats returns counters used by watchSummary to detect completion.
  if (u.endsWith("/api/stats")) {
    const summaries = served.filter(
      (s) => s.method === "POST" && s.path.endsWith("/api/sessions/summarize")
    ).length;
    const observations = served.filter(
      (s) => s.method === "POST" && s.path.endsWith("/api/sessions/observations")
    ).length;
    return new Response(
      JSON.stringify({ database: { summaries, observations, sessions: 1 } }),
      { status: 200 }
    );
  }
  return new Response("{}", { status: 200 });
};

const ctx = {
  project: { name: "opencode" },
  directory: "/home/yourname/test-project",
  client: {
    tui: {
      async showToast(p) {
        toastCalls.push(p);
      },
    },
  },
};

const mod = await import("./index.js");
// PluginModule shape: export default { id, server }
const ClaudeMemCapturePlugin = mod.default.server;
const plugin = await ClaudeMemCapturePlugin(ctx);
// The plugin returns a flat object: top-level keys are the hooks
// ("chat.message" / "tool.execute.after" / "experimental.session.compacting"
// / "event" / "tool"); there is no nested hooks key.
const hooks = plugin;

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

const reset = () => {
  served = [];
  toastCalls = [];
  failNext = 0;
  connRefused = false;
};

const SID = "test-session-1";

// ---- 1. assistant text part -> observation (flushed on message.updated) ----
await (async () => {
  reset();
  // A streamed assistant text part completes...
  await hooks["experimental.text.complete"](
    { sessionID: SID, messageID: "m1", partID: "p1" },
    { text: "We switched the memory backend to claude-mem; the worker listens on 37701." }
  );
  // ...and the assistant message is marked complete -> flush to observations.
  await hooks["event"]({
    event: {
      type: "message.updated",
      properties: {
        sessionID: SID,
        info: { id: "m1", role: "assistant", time: { completed: 1 } },
      },
    },
  });
  const obs = served.filter(
    (s) => s.method === "POST" && s.path.endsWith("/api/sessions/observations")
  );
  assert(obs.length === 1, "assistant message should yield 1 observation, got " + obs.length);
  assert(
    obs[0].body && typeof obs[0].body.tool_response === "string",
    "observation body.tool_response must be a string"
  );
  assert(
    obs[0].body.tool_response.includes("37701"),
    "observation should carry the original text, got: " + obs[0].body.tool_response
  );
  assert(
    obs[0].body.contentSessionId && obs[0].body.contentSessionId.length > 0,
    "contentSessionId must be a non-empty string"
  );
  console.log("PASS 1. assistant part -> observation");
})();

// ---- 2. user message -> init, never an observation ----
await (async () => {
  reset();
  await hooks["chat.message"](
    { sessionID: SID },
    {
      message: { id: "u1", role: "user" },
      parts: [{ type: "text", text: "please remember this for me" }],
    }
  );
  const obs = served.filter((s) => s.path.endsWith("/api/sessions/observations"));
  const inits = served.filter((s) => s.path.endsWith("/api/sessions/init"));
  assert(obs.length === 0, "user message must not yield an observation, got " + obs.length);
  assert(inits.length === 1, "user message should yield exactly 1 init, got " + inits.length);
  assert(
    inits[0].body.prompt && inits[0].body.prompt.includes("remember"),
    "init should carry the user prompt"
  );
  console.log("PASS 2. user message -> init (no observation)");
})();

// ---- 3. tool.execute.after -> observation (tool name + result) ----
await (async () => {
  reset();
  const input = { sessionID: SID, tool: "write" };
  const output = {
    args: { file_path: "/tmp/x.txt" },
    output: { content: [{ type: "text", text: "file written" }] },
  };
  await hooks["tool.execute.after"](input, output);
  const obs = served.filter((s) => s.path.endsWith("/api/sessions/observations"));
  assert(obs.length === 1, "tool result should yield 1 observation, got " + obs.length);
  assert(
    obs[0].body.tool_name === "write",
    "tool observation should record tool name write, got: " + obs[0].body.tool_name
  );
  assert(
    obs[0].body.tool_response.includes("file written"),
    "tool observation should contain the result text, got: " + obs[0].body.tool_response
  );
  console.log("PASS 3. tool.execute.after -> observation");
})();

// ---- 4. session.idle -> summarize (dedupe: two idles fire once) ----
await (async () => {
  reset();
  const idleEvent = {
    event: {
      type: "session.idle",
      properties: { sessionID: SID },
    },
  };
  await hooks["event"](idleEvent);
  await hooks["event"](idleEvent); // immediate repeat: the dedupe lock must block it
  const sum = served.filter((s) => s.path.endsWith("/api/sessions/summarize"));
  assert(sum.length === 1, "two consecutive idles should trigger 1 summarize, got " + sum.length);
  console.log("PASS 4. session.idle dedupe");
})();

// ---- 5. claude_mem_search tool ----
await (async () => {
  reset();
  const res = await plugin.tool.claude_mem_search.execute({ query: "memory backend" });
  assert(
    served.some((s) => s.path.includes("/api/search/observations")),
    "the search tool must call /api/search/observations"
  );
  assert(typeof res === "string" && res.length > 0, "search should return text");
  console.log("PASS 5. claude_mem_search");
})();

// ---- 6. worker flakiness: exponential-backoff retries then success ----
await (async () => {
  reset();
  failNext = 2; // first two calls 500, third succeeds
  await hooks["experimental.text.complete"](
    { sessionID: SID, messageID: "m6", partID: "p6" },
    { text: "retry test content" }
  );
  await hooks["event"]({
    event: {
      type: "message.updated",
      properties: {
        sessionID: SID,
        info: { id: "m6", role: "assistant", time: { completed: 1 } },
      },
    },
  });
  const failedAttempts = served.filter((s) => s.failed).length;
  const okObs = served.filter(
    (s) => s.method === "POST" && s.path.endsWith("/api/sessions/observations")
  ).length;
  assert(failedAttempts === 2, "expected 2 failed attempts, got " + failedAttempts);
  assert(okObs >= 1, "expected at least 1 successful observation after retry, got " + okObs);
  console.log("PASS 6. backoff retry");
})();

// ---- 7. ECONNREFUSED: give up immediately, no retries, no writes ----
await (async () => {
  reset();
  connRefused = true;
  await hooks["chat.message"](
    { sessionID: SID },
    {
      message: { id: "u7", role: "user" },
      parts: [{ type: "text", text: "x" }],
    }
  );
  const writes = served.filter(
    (s) =>
      s.method === "POST" &&
      (s.path.endsWith("/api/sessions/observations") ||
        s.path.endsWith("/api/sessions/summarize") ||
        s.path.endsWith("/api/sessions/init"))
  );
  assert(writes.length === 0, "ECONNREFUSED must not produce any write request (no retries)");
  console.log("PASS 7. ECONNREFUSED give up");
})();

// ---- 8. compacting -> summarize ----
await (async () => {
  reset();
  await hooks["experimental.session.compacting"]({ sessionID: SID });
  assert(
    served.some((s) => s.path.endsWith("/api/sessions/summarize")),
    "compacting should trigger summarize"
  );
  console.log("PASS 8. session.compacting -> summarize");
})();

console.log("\nALL TESTS PASSED");
