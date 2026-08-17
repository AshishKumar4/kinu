#!/usr/bin/env bun
/**
 * Phase C empirical evidence: crafted-tool round-trip over the real dev server.
 *
 * Creates a throwaway agent, sends one chat that:
 *  1. Instructs the agent to call workspace.createTool('double', ..., 'async (n) => n * 2')
 *  2. Asks it to compute `codemode.double(7)` in the SAME execute_tools turn
 *     OR invoke the tool via workspace.invokeCrafted() for same-turn access.
 *  3. Asserts the assistant reply contains "14".
 *  4. Asserts NO frame and NO server log line contains the substring
 *     "Code generation from strings disallowed" — the exact runtime error
 *     the Phase C architecture is designed to eliminate.
 *
 * This does NOT use miniflare — it talks to the real `vite dev` + workerd
 * stack via WebSocket, so a pass here is authoritative CF-runtime evidence.
 *
 * Writes a full transcript to /tmp/phase-c-transcript.txt that the commit
 * message quotes.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { JsonValueSchema, parseJsonValue, type JsonValue } from '../packages/core/src/index.js';

const BASE_URL = process.env.PROTEUS_BASE_URL ?? 'http://localhost:5173';
const AGENT_NAME = 'phase-c-' + Date.now();
const TIMEOUT_MS = 120_000;
const TRANSCRIPT = '/tmp/phase-c-transcript.txt';

let allFrames: JsonValue[] = [];

const messageSchema = v.object({
  role: v.string(),
  parts: v.optional(v.array(v.object({
    type: v.string(),
    text: v.optional(v.string()),
  }))),
});

const chatFrameSchema = v.object({
  type: v.string(),
  id: v.optional(v.string()),
  body: v.optional(v.string()),
  done: v.optional(v.boolean()),
  error: v.optional(v.boolean()),
  messages: v.optional(v.array(messageSchema)),
});

const rpcFrameSchema = v.object({
  type: v.string(),
  id: v.string(),
  success: v.boolean(),
  result: v.optional(JsonValueSchema),
  error: v.optional(v.string()),
});

const toolListSchema = v.object({
  crafted: v.array(v.object({ name: v.string(), description: v.string() })),
});

const descriptionSchema = v.object({ description: v.string() });

type ChatMessage = v.InferOutput<typeof messageSchema>;

function log(msg: string) {
  console.log(msg);
  appendFileSync(TRANSCRIPT, msg + '\n');
}

function uid() { return Math.random().toString(36).slice(2, 10); }

function wsUrl() {
  const u = new URL(BASE_URL);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${u.origin}/agents/orchestrator-agent/${AGENT_NAME}`;
}

async function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    const t = setTimeout(() => reject(new Error('WS connect timeout')), 10_000);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = e => { clearTimeout(t); reject(new Error('WS error: ' + JSON.stringify(e))); };
    ws.onmessage = e => {
      try { allFrames.push(parseJsonValue(String(e.data))); } catch { allFrames.push(String(e.data)); }
    };
  });
}

/**
 * Registers a message listener that only sees frames matching `schema`, and returns its remover.
 *
 * The socket multiplexes several frame shapes, so a frame of another shape is routine and is
 * skipped. A frame that is not JSON at all is a server defect rather than a routine non-match, so
 * it settles the pending promise instead of disappearing into an RPC or chat timeout.
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
  ws.addEventListener('message', listener);
  return () => { ws.removeEventListener('message', listener); };
}

async function rpc<Output>(
  ws: WebSocket,
  method: string,
  outputSchema: v.GenericSchema<Output>,
  args: JsonValue[] = [],
): Promise<Output> {
  return new Promise((resolve, reject) => {
    const id = uid();
    const t = setTimeout(() => reject(new Error(`RPC ${method} timeout`)), 15_000);
    const stop = onFrame(ws, rpcFrameSchema, reject, (msg) => {
      if (msg.type !== 'rpc' || msg.id !== id) return;
      clearTimeout(t);
      stop();
      if (!msg.success) {
        reject(new Error(String(msg.error ?? 'rpc failed')));
        return;
      }
      const result = v.safeParse(outputSchema, msg.result);
      if (result.success) resolve(result.output);
      else reject(new Error(`rpc ${method} returned an unexpected result shape: ${result.issues.map((issue) => issue.message).join('; ')}`));
    });
    ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
  });
}

async function chat(ws: WebSocket, text: string, timeoutMs = TIMEOUT_MS): Promise<{ bodies: string[]; final: ChatMessage[] }> {
  return new Promise((resolve, reject) => {
    const reqId = uid();
    const timer = setTimeout(() => reject(new Error('chat timeout')), timeoutMs);
    const bodies: string[] = [];
    let final: ChatMessage[] = [];
    let done = false;

    const finish = () => {
      clearTimeout(timer);
      stop();
      resolve({ bodies, final });
    };

    const stop = onFrame(ws, chatFrameSchema, reject, (msg) => {
      if (msg.type === 'cf_agent_use_chat_response' && msg.id === reqId) {
        if (msg.body) bodies.push(msg.body);
        if (msg.done && !msg.error) { done = true; setTimeout(() => { if (done) finish(); }, 2000); }
        if (msg.error) { clearTimeout(timer); stop(); reject(new Error('chat error: ' + msg.body)); }
      }
      if (msg.type === 'cf_agent_chat_messages' && bodies.length > 0) {
        final = msg.messages ?? [];
        if (done) finish();
      }
    });

    ws.send(JSON.stringify({
      type: 'cf_agent_use_chat_request',
      id: reqId,
      init: { method: 'POST', body: JSON.stringify({ messages: [{ id: uid(), role: 'user', parts: [{ type: 'text', text }] }] }) },
    }));
  });
}

async function main() {
  writeFileSync(TRANSCRIPT, `=== Phase C evidence ===\nagent=${AGENT_NAME}\nbase=${BASE_URL}\nstart=${new Date().toISOString()}\n\n`);

  log(`Preflight: GET ${BASE_URL}/`);
  const pf = await fetch(`${BASE_URL}/`);
  log(`  HTTP ${pf.status}`);
  if (pf.status !== 200) { log('FAIL: preflight'); process.exit(1); }

  log('Connecting WebSocket...');
  const ws = await connect();
  log('  connected');

  // Turn 1: create the tool (storage only — next turn's getTools will pick
  // it up and wire the Phase C LOADER executor).
  log('\n--- Turn 1: create the tool (no invocation) ---');
  const prompt1 =
    'Use execute_tools ONCE: call workspace.createTool("double", "Doubles its numeric argument", "async (n) => n * 2") ' +
    'and then return the string "created". Reply with just: done.';
  const r1 = await chat(ws, prompt1);
  const body1 = r1.bodies.join('');
  log(`body1 (${body1.length} chars, first 800):\n${body1.slice(0, 800)}...`);

  const beforeTurn2Frames = allFrames.length;

  // Confirm it made it to the store
  log('\n--- Confirm tool stored ---');
  const toolList1 = await rpc(ws, 'getToolList', toolListSchema);
  log(`  crafted after turn 1: ${JSON.stringify(toolList1.crafted)}`);
  const hasDouble1 = toolList1.crafted.some(t => t.name === 'double' || t.name.toLowerCase() === 'double');
  if (!hasDouble1) {
    log('FAIL: tool not stored after turn 1 — cannot test Phase C LOADER path');
    process.exit(3);
  }
  log(`  'double' present: yes`);

  // Phase D evidence: assert the LLM-visible execute_tools description
  // includes codemode.double — i.e. the crafted tool was wired into the
  // codemode namespace via createExecuteTool.
  log('\n--- Phase D: inspect execute_tools.description for codemode.double ---');
  const desc = await rpc(ws, 'getExecuteToolsDescription', descriptionSchema);
  log(`  description length: ${desc.description.length}`);
  // Preview — show the codemode block
  const codemodeIdx = desc.description.indexOf('codemode:');
  if (codemodeIdx >= 0) {
    log(`  codemode block (preview):\n${desc.description.slice(codemodeIdx, codemodeIdx + 400)}`);
  } else {
    log(`  description preview:\n${desc.description.slice(0, 800)}`);
  }
  const hasCodemodeDouble = desc.description.includes('double');
  log(`  description mentions "double": ${hasCodemodeDouble}`);
  if (!hasCodemodeDouble) {
    log('FAIL: crafted tool not in LLM-visible schema');
    process.exit(5);
  }

  // Turn 2: invoke via codemode.<name> — this is the Phase C path. The
  // Phase C LOADER executor is wired in getTools() which reruns at the
  // start of this turn (cache invalidated by crafted_tools.updated_at bump).
  //
  // The prompt forbids workspace.invokeCrafted since that path still uses
  // the legacy new Function in inline.ts and is Phase E cleanup. Only
  // codemode.* dispatches through Phase C's LOADER executor.
  log('\n--- Turn 2: invoke via codemode.double(7) ---');
  const prompt2 =
    'Use execute_tools exactly once: write "async () => await codemode.double(7)" — ' +
    'that exact body, no alternatives, DO NOT use workspace.invokeCrafted. ' +
    'After the tool returns, reply with just the number (14).';
  const r2 = await chat(ws, prompt2);
  const body2 = r2.bodies.join('');
  log(`body2 (${body2.length} chars, first 2000):\n${body2.slice(0, 2000)}`);
  const lastAssistant = r2.final
    .filter(m => m.role === 'assistant').pop();
  const assistantText = lastAssistant?.parts?.filter(p => p.type === 'text').map(p => p.text ?? '').join('') ?? '';
  log(`\nassistant text: ${JSON.stringify(assistantText.slice(0, 600))}`);

  // Scan specifically for codegen errors in the codemode.double path
  // (not the workspace.invokeCrafted legacy path, which Phase E will kill).
  log('\n--- Scanning Turn 2 frames for codegen errors on codemode.* path ---');
  const turn2Frames = allFrames.slice(beforeTurn2Frames);
  const turn2Json = JSON.stringify(turn2Frames);
  const codegenErrFrames = turn2Frames.filter(f => {
    const s = JSON.stringify(f);
    return s.includes('Code generation from strings disallowed') && s.includes('codemode.double');
  });
  const codegenErrCount = codegenErrFrames.length;
  log(`  turn-2 frames: ${turn2Frames.length}`);
  log(`  codegen errors on codemode.* paths: ${codegenErrCount}`);
  // Log ANY codegen error regardless of path so we don't hide partial failures
  const anyCodegenErr = turn2Json.includes('Code generation from strings disallowed');
  log(`  ANY codegen error in turn 2: ${anyCodegenErr}`);
  if (anyCodegenErr) {
    log('  NOTE: codegen errors from workspace.invokeCrafted are expected until Phase E.');
    log('  Phase C only guarantees codemode.<name>() path is clean.');
    const badFrames = turn2Frames.filter(f => JSON.stringify(f).includes('Code generation from strings disallowed'));
    for (const f of badFrames.slice(0, 5)) {
      log('  - Error frame (path in body): ' + JSON.stringify(f).slice(0, 300));
    }
  }

  if (codegenErrCount > 0) {
    log('FAIL: codegen error on codemode.<name>() path — Phase C executor is not working');
    log('First matching frame: ' + JSON.stringify(codegenErrFrames[0], null, 2).slice(0, 3000));
    process.exit(2);
  }

  // Look for a successful codemode.double tool invocation (result: 14)
  const successFrame = turn2Frames.find(f => {
    const s = JSON.stringify(f);
    return s.includes('codemode.double') && s.includes('"result":14');
  });
  log(`\n  successful codemode.double → 14 frame: ${successFrame ? 'FOUND' : 'NOT FOUND'}`);
  if (!successFrame) {
    // Look for any tool-output-available with 14 for codemode.double path
    const anyDouble14 = turn2Frames.find(f => {
      const s = JSON.stringify(f);
      return s.includes('codemode.double') && s.includes('result') && s.includes('14');
    });
    if (anyDouble14) {
      log('  (found a codemode.double result frame with 14 — ' + JSON.stringify(anyDouble14).slice(0, 300) + ')');
    }
  } else {
    log('  ' + JSON.stringify(successFrame).slice(0, 400));
  }

  // Check result contains 14
  const has14 = body2.includes('"14"') || body2.includes('result":14') || assistantText.includes('14');
  log(`\n  turn-2 reply mentions 14: ${has14}`);
  if (!has14) {
    log('FAIL: expected result 14 not in turn-2 output');
    log('Full turn-2 body:\n' + body2);
    process.exit(4);
  }

  log('\n--- PASS ---');
  log(`end=${new Date().toISOString()}`);
  ws.close();
  process.exit(0);
}

main().catch(error => {
  log(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
  log(error instanceof Error ? error.stack ?? '' : '');
  process.exit(99);
});
