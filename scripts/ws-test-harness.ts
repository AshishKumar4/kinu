#!/usr/bin/env bun
/**
 * WebSocket test harness for Kinu E2E tests.
 *
 * Connects to the Durable Object via WebSocket, sends RPC calls
 * and chat messages, and validates responses. Outputs TAP-like
 * results that the shell wrapper parses.
 *
 * Usage: bun scripts/ws-test-harness.ts [base-url] [agent-name]
 */

import * as v from "valibot";
import { BUILTIN_TOOLS, JsonValueSchema, parseJsonValue, type JsonValue } from "../packages/core/src/index";

const BASE_URL = process.argv[2] ?? "http://localhost:5173";
const AGENT_NAME = process.argv[3] ?? "e2e-test-agent";
const TIMEOUT_MS = 30_000;

const chatFrameSchema = v.object({
  type: v.string(),
  id: v.optional(v.string()),
  body: v.optional(v.string()),
  done: v.optional(v.boolean()),
  error: v.optional(v.boolean()),
  messages: v.optional(v.array(JsonValueSchema)),
});

const rpcFrameSchema = v.object({
  type: v.string(),
  id: v.string(),
  success: v.boolean(),
  result: v.optional(JsonValueSchema),
  error: v.optional(v.string()),
});

const agentStatusSchema = v.object({ name: v.string(), model: v.string() });
const toolListSchema = v.object({
  builtIn: v.array(v.string()),
  crafted: v.array(JsonValueSchema),
});
const modelListSchema = v.object({
  current: v.string(),
  models: v.array(JsonValueSchema),
});
const memoryContentSchema = v.string();

// ── helpers ──────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function pass(name: string, detail?: string) {
  passCount++;
  const extra = detail ? ` — ${detail}` : "";
  console.log(`PASS: ${name}${extra}`);
}

function fail(name: string, detail?: string) {
  failCount++;
  const extra = detail ? ` — ${detail}` : "";
  console.log(`FAIL: ${name}${extra}`);
}

function errorMessage<Failure>(error: Failure): string {
  return error instanceof Error ? error.message : String(error);
}

function wsUrl(): string {
  return BASE_URL.replace(/^http/, "ws") + `/agents/orchestrator-agent/${AGENT_NAME}`;
}

function httpUrl(path: string): string {
  return `${BASE_URL}/agents/orchestrator-agent/${AGENT_NAME}${path}`;
}

function uid(): string {
  return crypto.randomUUID();
}

/**
 * Registers a message listener that only sees frames matching `schema`, and returns its remover.
 *
 * These sockets multiplex several frame shapes, so a frame of another shape is routine and is
 * skipped. A frame that is not JSON at all is a server defect rather than a routine non-match, so
 * it settles the pending promise instead of disappearing into a connect or RPC timeout.
 */
function onFrame<Output>(
  ws: WebSocket,
  schema: v.GenericSchema<Output>,
  reject: (error: Error) => void,
  handle: (frame: Output) => void,
): () => void {
  const listener = (ev: MessageEvent) => {
    const raw = String(ev.data);
    let decoded: JsonValue;
    try {
      decoded = parseJsonValue(raw);
    } catch (error) {
      reject(new Error(`server sent a non-JSON frame: ${raw.slice(0, 200)}`, { cause: error }));
      return;
    }
    const parsed = v.safeParse(schema, decoded);
    if (parsed.success) handle(parsed.output);
  };
  ws.addEventListener("message", listener);
  return () => { ws.removeEventListener("message", listener); };
}

/** Open a WebSocket with a timeout. Resolves once the initial message history arrives. */
function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), TIMEOUT_MS);
    const ws = new WebSocket(wsUrl());
    ws.addEventListener("open", () => {});
    onFrame(ws, chatFrameSchema, reject, (msg) => {
      if (msg.type === "cf_agent_chat_messages") {
        clearTimeout(timer);
        resolve(ws);
      }
    });
    ws.addEventListener("error", (ev) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${ev}`));
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket closed before ready"));
    });
  });
}

/** Send an RPC and wait for its response. */
function rpc<Output>(
  ws: WebSocket,
  method: string,
  outputSchema: v.GenericSchema<Output>,
  args: JsonValue[] = [],
): Promise<Output> {
  return new Promise((resolve, reject) => {
    const id = uid();
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timeout`)), TIMEOUT_MS);

    const stop = onFrame(ws, rpcFrameSchema, reject, (msg) => {
      if (msg.type !== "rpc" || msg.id !== id) return;
      clearTimeout(timer);
      stop();
      if (!msg.success) {
        reject(new Error(msg.error ?? "RPC failed"));
        return;
      }
      const result = v.safeParse(outputSchema, msg.result);
      if (result.success) resolve(result.output);
      else reject(new Error(`RPC ${method} returned an unexpected result shape: ${result.issues.map((issue) => issue.message).join("; ")}`));
    });

    ws.send(JSON.stringify({ type: "rpc", id, method, args }));
  });
}

/** Send a chat message and collect all streamed response chunks. Returns concatenated body text. */
function chat(ws: WebSocket, text: string, timeoutMs = TIMEOUT_MS): Promise<{ bodies: string[] }> {
  return new Promise((resolve, reject) => {
    const reqId = uid();
    const timer = setTimeout(() => reject(new Error("Chat response timeout")), timeoutMs);
    const bodies: string[] = [];
    let streamDone = false;

    const finish = () => {
      clearTimeout(timer);
      stop();
      resolve({ bodies });
    };

    const stop = onFrame(ws, chatFrameSchema, reject, (msg) => {
      // Collect streamed response chunks
      if (msg.type === "cf_agent_use_chat_response" && msg.id === reqId) {
        if (msg.body) bodies.push(msg.body);
        if (msg.done && !msg.error) {
          streamDone = true;
          // Give 2s for the cf_agent_chat_messages broadcast to arrive
          setTimeout(() => { if (streamDone) finish(); }, 2000);
        }
        if (msg.error) {
          clearTimeout(timer);
          stop();
          reject(new Error(`Chat error: ${msg.body}`));
        }
      }

      // The full message list comes after the stream completes
      if (msg.type === "cf_agent_chat_messages" && bodies.length > 0) {
        if (streamDone) finish();
      }
    });

    const userMessage = {
      id: uid(),
      role: "user",
      parts: [{ type: "text", text }],
    };

    ws.send(JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: reqId,
      init: {
        method: "POST",
        body: JSON.stringify({ messages: [userMessage] }),
      },
    }));
  });
}


// ── tests ────────────────────────────────────────────────────────

async function testHttpGetMessages() {
  try {
    const resp = await fetch(httpUrl("/get-messages"), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (resp.ok) {
      const data = v.parse(v.array(JsonValueSchema), await resp.json());
      pass("HTTP GET /get-messages", `status=${resp.status}, ${data.length} messages`);
    } else {
      fail("HTTP GET /get-messages", `status=${resp.status}`);
    }
  } catch (error) {
    fail("HTTP GET /get-messages", errorMessage(error));
  }
}

async function testRpcGetAgentStatus(ws: WebSocket) {
  try {
    const result = await rpc(ws, "getAgentStatus", agentStatusSchema);
    if (result.name.length > 0 && result.model.length > 0) {
      pass("RPC getAgentStatus", `name=${result.name}, model=${result.model}`);
    } else {
      fail("RPC getAgentStatus", `unexpected shape: ${JSON.stringify(result).slice(0, 200)}`);
    }
  } catch (error) {
    fail("RPC getAgentStatus", errorMessage(error));
  }
}

async function testRpcGetToolList(ws: WebSocket) {
  try {
    const result = await rpc(ws, "getToolList", toolListSchema);
    const expectedTools: readonly string[] = BUILTIN_TOOLS;
    const hasAll = expectedTools.every(t => result.builtIn.includes(t));
    if (hasAll && result.builtIn.length === expectedTools.length) {
      pass("RPC getToolList", `builtIn=[${result.builtIn.join(",")}], crafted=${result.crafted.length}`);
    } else {
      fail("RPC getToolList", `builtIn=${JSON.stringify(result.builtIn)}`);
    }
  } catch (error) {
    fail("RPC getToolList", errorMessage(error));
  }
}

async function testRpcGetEvolutionEvents(ws: WebSocket) {
  try {
    const result = await rpc(ws, "getEvolutionEvents", v.array(JsonValueSchema), [10]);
    pass("RPC getEvolutionEvents", `${result.length} events`);
  } catch (error) {
    fail("RPC getEvolutionEvents", errorMessage(error));
  }
}

async function testRpcGetMctsTree(ws: WebSocket) {
  try {
    const result = await rpc(ws, "getMctsTree", v.array(JsonValueSchema));
    pass("RPC getMctsTree", `${result.length} nodes`);
  } catch (error) {
    fail("RPC getMctsTree", errorMessage(error));
  }
}

async function testRpcGetExecutors(ws: WebSocket) {
  try {
    const result = await rpc(ws, "getExecutors", v.array(JsonValueSchema));
    pass("RPC getExecutors", `${result.length} executors`);
  } catch (error) {
    fail("RPC getExecutors", errorMessage(error));
  }
}

async function testRpcGetAvailableModels(ws: WebSocket) {
  try {
    const result = await rpc(ws, "getAvailableModels", modelListSchema);
    if (result.current.length > 0) {
      pass("RPC getAvailableModels", `current=${result.current}, ${result.models.length} models`);
    } else {
      fail("RPC getAvailableModels", `unexpected: ${JSON.stringify(result).slice(0, 200)}`);
    }
  } catch (error) {
    fail("RPC getAvailableModels", errorMessage(error));
  }
}

async function testChatStreaming(ws: WebSocket) {
  try {
    // Switch to fast model first
    await rpc(ws, "setModel", v.optional(JsonValueSchema), ["@cf/meta/llama-4-scout-17b-16e-instruct"]);

    const { bodies } = await chat(ws, "Reply with exactly: PONG");

    // (a) Response streams back (not empty)
    if (bodies.length === 0) {
      fail("Chat streams back", "zero body chunks received");
      return;
    }
    pass("Chat streams back", `${bodies.length} chunks`);

    // Check that the full response contains text
    const allBody = bodies.join("");
    if (allBody.length > 0) {
      pass("Chat response not empty", `${allBody.length} chars total`);
    } else {
      fail("Chat response not empty", "concatenated body is empty");
    }
  } catch (error) {
    fail("Chat streams back", errorMessage(error));
    fail("Chat response not empty", "skipped — depends on chat streaming");
  }
}

async function testChatToolCalls(ws: WebSocket) {
  try {
    const { bodies } = await chat(
      ws,
      'Use the memory tool to save the exact content "e2e-test-marker-42". Then reply DONE.',
      60_000,
    );
    const allBody = bodies.join("");

    // (b) Tool calls appear in the response stream
    // The stream includes tool-call and tool-result parts in the UIMessageStream format
    const hasToolIndicator =
      allBody.includes('"toolName":"memory"') ||
      allBody.includes("tool-call") ||
      allBody.includes("tool_call") ||
      allBody.includes("tool-result") ||
      allBody.includes('"toolCallId"') ||
      allBody.includes('"toolName"');

    if (hasToolIndicator) {
      pass("Chat tool calls appear in stream", "found tool-related content");
    } else {
      // Even if the raw stream doesn't show it, check the final messages
      fail("Chat tool calls appear in stream", `no tool indicators in ${allBody.length} chars of stream`);
    }
  } catch (error) {
    fail("Chat tool calls appear in stream", errorMessage(error));
  }
}

let workspaceMarker = '';

async function testWorkspaceReadFile(ws: WebSocket) {
  try {
    if (!workspaceMarker) throw new Error('write-file probe did not produce a marker');
    const { bodies } = await chat(
      ws,
      'Use the file tool to read test-e2e.txt, then reply with the exact file content.',
      60_000,
    );
    const allBody = bodies.join("");
    if (allBody.includes(workspaceMarker)) {
      pass("file.read", `read marker "${workspaceMarker}"`);
    } else {
      fail("file.read", `marker absent from ${allBody.length} response characters`);
    }
  } catch (error) {
    fail("file.read", errorMessage(error));
  }
}

async function testWorkspaceWriteFile(ws: WebSocket) {
  try {
    workspaceMarker = `e2e-${Date.now()}`;
    const { bodies } = await chat(
      ws,
      `Use the file tool to write the exact text "${workspaceMarker}" to test-e2e.txt, `
        + 'then read the file and reply with its content.',
      60_000,
    );
    const allBody = bodies.join("");
    if (allBody.includes(workspaceMarker)) {
      pass("file.write + file.read round-trip", `marker "${workspaceMarker}" found in response`);
    } else {
      fail("file.write + file.read round-trip", `marker absent from ${allBody.length} response characters`);
    }
  } catch (error) {
    fail("file.write + file.read round-trip", errorMessage(error));
  }
}

async function testMemorySave(ws: WebSocket) {
  try {
    const marker = `kinu-e2e-${Date.now()}`;
    await chat(
      ws,
      `Use the memory tool to save exactly this content: "${marker}". Reply only DONE.`,
      60_000,
    );
    const memory = await rpc(ws, "getMemoryContent", memoryContentSchema);
    if (memory.includes(marker)) {
      pass("memory.save", `found marker "${marker}" in MEMORY.md`);
    } else {
      fail("memory.save", "MEMORY.md does not contain the saved marker");
    }
  } catch (error) {
    fail("memory.save", errorMessage(error));
  }
}

async function testClearConversation(ws: WebSocket) {
  try {
    // Clear conversation for cleanup
    ws.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
    // Wait a moment for it to take effect
    await new Promise(r => setTimeout(r, 500));
    pass("Clear conversation", "sent cf_agent_chat_clear");
  } catch (error) {
    fail("Clear conversation", errorMessage(error));
  }
}

// ── main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\nKinu Web E2E Tests`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Agent:  ${AGENT_NAME}`);
  console.log(`────────────────────────────────────`);

  // §1 — HTTP endpoint
  console.log(`\n§1. HTTP Endpoints`);
  await testHttpGetMessages();

  // §2 — WebSocket RPC
  console.log(`\n§2. WebSocket RPC`);
  let ws: WebSocket;
  try {
    ws = await connect();
    pass("WebSocket connect", `connected to ${wsUrl()}`);
  } catch (error) {
    fail("WebSocket connect", errorMessage(error));
    console.log(`\nDONE: ${passCount} passed, ${failCount} failed`);
    process.exit(failCount > 0 ? 1 : 0);
  }

  await testRpcGetAgentStatus(ws);
  await testRpcGetToolList(ws);
  await testRpcGetEvolutionEvents(ws);
  await testRpcGetMctsTree(ws);
  await testRpcGetExecutors(ws);
  await testRpcGetAvailableModels(ws);

  // §3 — Chat (requires LLM)
  console.log(`\n§3. Chat (LLM-backed)`);
  await testChatStreaming(ws);
  await testChatToolCalls(ws);

  // §4 — Workspace operations via chat
  console.log(`\n§4. Workspace Operations`);
  await testWorkspaceWriteFile(ws);
  await testWorkspaceReadFile(ws);

  // §5 — Memory round-trip
  console.log(`\n§5. Memory Round-Trip`);
  await testMemorySave(ws);

  // Cleanup
  console.log(`\n§6. Cleanup`);
  await testClearConversation(ws);

  ws.close();

  // Summary
  console.log(`\n────────────────────────────────────`);
  console.log(`DONE: ${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

try {
  await main();
} catch (cause) {
  console.error("FATAL:", cause);
  process.exit(1);
}
