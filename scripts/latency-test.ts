#!/usr/bin/env bun
/**
 * Latency baseline test — measures time-to-first-chunk for the platform default
 * via the AI Gateway directly, bypassing all Kinu/Think/DO overhead.
 *
 * Usage: AI_GATEWAY_AUTH='Bearer <token>' bun scripts/latency-test.ts
 *
 * Reads AI_GATEWAY_URL from packages/cf-backend/.dev.vars. The token is this
 * script's own: it speaks raw HTTPS, so it cannot use the Workers AI binding the
 * Worker itself reaches the gateway through. Kinu needs no such token.
 */

import { readFileSync } from "fs";
import * as v from "valibot";
import { parseJsonValue } from "../packages/core/src/utils/json";
import { tolerate } from "../packages/core/src/obs/index";

// Load credentials from .dev.vars
const devVars = readFileSync("packages/cf-backend/.dev.vars", "utf8");
const vars: Record<string, string> = {};
for (const line of devVars.split("\n")) {
  const eq = line.indexOf("=");
  if (eq > 0) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}

const GATEWAY_URL = vars.AI_GATEWAY_URL;
const GATEWAY_AUTH = process.env.AI_GATEWAY_AUTH ?? vars.AI_GATEWAY_AUTH;
const MODEL = "@cf/deepseek-ai/deepseek-v4-pro-0813";
const FAST_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

if (!GATEWAY_URL || !GATEWAY_AUTH) {
  console.error("Need AI_GATEWAY_URL in packages/cf-backend/.dev.vars and AI_GATEWAY_AUTH in the environment");
  process.exit(1);
}

// The full Kinu system prompt (same as orchestrator.ts getSystemPrompt)
const FULL_SYSTEM_PROMPT = `A self-evolving coding assistant with MCTS exploration and durable skill evolution.

## Tools (5 tools)

### execute_tools
Write JavaScript to accomplish tasks. Your code runs in a sandboxed Worker with these APIs:

**workspace.*** — file and shell operations on your persistent virtual filesystem:
  workspace.readFile(path) → string
  workspace.writeFile(path, content) → "ok"
  workspace.readdir(path) → string[]
  workspace.exists(path) → boolean
  workspace.exec(command) → string — POSIX shell (cat, grep, find, sed, ls, head, tail, wc, mkdir, rm, cp, mv)
  workspace.searchMemory(query) → results
  workspace.saveNote(content) → "ok"
  workspace.listTools() → tool list
  workspace.createTool(name, description, code) → "ok"

**tools.*** — the native tools plus your learned ones from the CraftStore:
  tools.<name>(args) — call any native or crafted tool by name

Use Promise.all for parallel operations. Return a value to see the result.

### run
Run a shell command directly: run({ command: "ls -la" })
Supports: cat, grep, find, sed, ls, tree, head, tail, wc, mkdir, rm, cp, mv, echo, sort, uniq.
Pipes (|) and redirects (>, >>) work. Pass executor to target nimbus/sandbox.

### explore
MCTS tree search for complex subproblems. Use for architecture decisions or multi-step problem solving.

### save_note
Save a note to long-term memory (FTS-indexed). Quick persist — no code needed.

### search_memory
Full-text search over long-term memory. Quick recall — no code needed.

## Evolution
Your capabilities improve automatically via CraftStore — good patterns become codemode.* APIs inside execute_tools.
Summarize what you did after using tools.`;

// Tool schemas that Kinu registers (execute_tools, run, explore, save_note, search_memory)
const TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "execute_tools",
      description: "Execute code to achieve a goal. Write an async arrow function in JavaScript that returns the result.",
      parameters: { type: "object", properties: { code: { type: "string", description: "JavaScript code to execute" } }, required: ["code"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run",
      description: "Run a shell command. Supports: cat, grep, find, sed, ls, tree, head, tail, wc, mkdir, rm, cp, mv, echo, sort, uniq. Pipes and redirects work.",
      parameters: { type: "object", properties: { command: { type: "string" }, executor: { type: "string" } }, required: ["command"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "explore",
      description: "MCTS tree search for complex subproblems.",
      parameters: { type: "object", properties: { task: { type: "string" }, budget: { type: "number" } }, required: ["task"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "save_note",
      description: "Save a note to long-term memory (FTS-indexed for later search).",
      parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_memory",
      description: "Full-text search over long-term memory. Returns matching passages.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  // Think's built-in workspace tools (7 of them: read, write, edit, list, find, grep, delete)
  {
    type: "function" as const,
    function: {
      name: "read",
      description: "Read a file with line numbers.",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write",
      description: "Write content to a file.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit",
      description: "Edit a file with search/replace.",
      parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list",
      description: "List directory contents.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find",
      description: "Find files by glob pattern.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grep",
      description: "Search file contents with regex.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } }, required: ["pattern"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete",
      description: "Delete a file or directory.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

// ── Test runner ───────────────────────────────────────────────────

interface TestResult {
  name: string;
  ttfc: number;    // time to first chunk (ms)
  total: number;   // total response time (ms)
  firstChunk: string;
  error?: string;
}

interface GatewayMessage {
  role: "system" | "user";
  content: string;
}

interface GatewayRequest {
  model: string;
  messages: GatewayMessage[];
  stream: true;
  max_tokens: number;
  tools?: typeof TOOL_SCHEMAS;
}

const streamChunkSchema = v.object({
  choices: v.array(v.object({
    delta: v.object({
      content: v.optional(v.string()),
      reasoning_content: v.optional(v.string()),
    }),
  })),
});

function errorMessage<Failure>(error: Failure): string {
  return error instanceof Error ? error.message : String(error);
}

async function measureStreaming(opts: {
  name: string;
  model: string;
  systemPrompt?: string;
  userMessage: string;
  tools?: typeof TOOL_SCHEMAS;
}): Promise<TestResult> {
  const messages: GatewayMessage[] = [];
  if (opts.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
  messages.push({ role: "user", content: opts.userMessage });
  const body: GatewayRequest = {
    model: opts.model,
    messages,
    stream: true,
    max_tokens: 128,
  };
  if (opts.tools?.length) body.tools = opts.tools;

  const t0 = performance.now();
  let ttfc = -1;
  let firstChunk = "";

  try {
    const resp = await fetch(`${GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": GATEWAY_AUTH,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { name: opts.name, ttfc: -1, total: performance.now() - t0, firstChunk: "", error: `HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }

    if (!resp.body) {
      return {
        name: opts.name,
        ttfc: -1,
        total: performance.now() - t0,
        firstChunk: "",
        error: "Gateway response had no body",
      };
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let totalText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      totalText += text;

      if (ttfc < 0) {
        ttfc = performance.now() - t0;
        // Extract first meaningful content from SSE
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          const decoded = tolerate(() => parseJsonValue(line.slice(6)), "malformed-input");
          if (decoded === undefined) continue;
          const parsed = v.safeParse(streamChunkSchema, decoded);
          if (!parsed.success) continue;
          const delta = parsed.output.choices[0]?.delta;
          if (delta?.content) { firstChunk = delta.content.slice(0, 60); break; }
          if (delta?.reasoning_content) { firstChunk = `[reasoning] ${delta.reasoning_content.slice(0, 50)}`; break; }
        }
      }
    }

    const total = performance.now() - t0;
    return { name: opts.name, ttfc, total, firstChunk };
  } catch (error) {
    return { name: opts.name, ttfc: -1, total: performance.now() - t0, firstChunk: "", error: errorMessage(error) };
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Kinu Latency Baseline — Direct AI Gateway Tests         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`Gateway: ${GATEWAY_URL.slice(0, 50)}...`);
  console.log(`Model:   ${MODEL}`);
  console.log("");

  const results: TestResult[] = [];

  // Test 1: Kimi K2.5 — minimal prompt, no tools
  console.log("▶ Test 1: Kimi K2.5 — minimal prompt, no tools...");
  results.push(await measureStreaming({
    name: "Kimi K2.5 (no tools, minimal)",
    model: MODEL,
    userMessage: "Say hi",
  }));
  console.log(`  → TTFC: ${results.at(-1)!.ttfc.toFixed(0)}ms, first: "${results.at(-1)!.firstChunk}" ${results.at(-1)!.error ?? ""}`);

  // Test 2: Kimi K2.5 — full system prompt, no tools
  console.log("▶ Test 2: Kimi K2.5 — full system prompt, no tools...");
  results.push(await measureStreaming({
    name: "Kimi K2.5 (full prompt, no tools)",
    model: MODEL,
    systemPrompt: FULL_SYSTEM_PROMPT,
    userMessage: "Say hi",
  }));
  console.log(`  → TTFC: ${results.at(-1)!.ttfc.toFixed(0)}ms, first: "${results.at(-1)!.firstChunk}" ${results.at(-1)!.error ?? ""}`);

  // Test 3: Kimi K2.5 — full system prompt + all 12 tool schemas
  console.log("▶ Test 3: Kimi K2.5 — full prompt + 12 tool schemas...");
  results.push(await measureStreaming({
    name: "Kimi K2.5 (full prompt + tools)",
    model: MODEL,
    systemPrompt: FULL_SYSTEM_PROMPT,
    tools: TOOL_SCHEMAS,
    userMessage: "Say hi",
  }));
  console.log(`  → TTFC: ${results.at(-1)!.ttfc.toFixed(0)}ms, first: "${results.at(-1)!.firstChunk}" ${results.at(-1)!.error ?? ""}`);

  // Test 4: Llama 4 Scout — same full prompt + tools (baseline comparison)
  console.log("▶ Test 4: Llama 4 Scout — full prompt + tools...");
  results.push(await measureStreaming({
    name: "Llama Scout (full prompt + tools)",
    model: FAST_MODEL,
    systemPrompt: FULL_SYSTEM_PROMPT,
    tools: TOOL_SCHEMAS,
    userMessage: "Say hi",
  }));
  console.log(`  → TTFC: ${results.at(-1)!.ttfc.toFixed(0)}ms, first: "${results.at(-1)!.firstChunk}" ${results.at(-1)!.error ?? ""}`);

  // Test 5: Kimi K2.5 — complex prompt to trigger reasoning
  console.log("▶ Test 5: Kimi K2.5 — complex task (triggers reasoning)...");
  results.push(await measureStreaming({
    name: "Kimi K2.5 (complex task)",
    model: MODEL,
    systemPrompt: FULL_SYSTEM_PROMPT,
    tools: TOOL_SCHEMAS,
    userMessage: "Write a TypeScript function that implements a red-black tree with insert and delete operations.",
  }));
  console.log(`  → TTFC: ${results.at(-1)!.ttfc.toFixed(0)}ms, first: "${results.at(-1)!.firstChunk}" ${results.at(-1)!.error ?? ""}`);

  // Summary table
  console.log("\n╔══════════════════════════════════════════════════════╦═══════════╦═══════════╗");
  console.log("║ Test                                                 ║   TTFC    ║   Total   ║");
  console.log("╠══════════════════════════════════════════════════════╬═══════════╬═══════════╣");
  for (const r of results) {
    const name = r.name.padEnd(52);
    const ttfc = r.error ? "ERROR".padStart(7) : `${(r.ttfc / 1000).toFixed(1)}s`.padStart(7);
    const total = `${(r.total / 1000).toFixed(1)}s`.padStart(7);
    console.log(`║ ${name} ║ ${ttfc}   ║ ${total}   ║`);
  }
  console.log("╚══════════════════════════════════════════════════════╩═══════════╩═══════════╝");

  if (results.some(r => r.error)) {
    console.log("\nErrors:");
    for (const r of results) if (r.error) console.log(`  ${r.name}: ${r.error}`);
  }
}

try {
  await main();
} catch (cause) {
  console.error("FATAL:", cause);
  process.exit(1);
}
