#!/usr/bin/env bun
/**
 * Reproduce the same-turn codemode.<name> invisibility bug.
 *
 * User's report: in one turn, "create a tool called double, then double 7":
 *   - workspace.createTool('double', ..., '(n) => n * 2') → ok:true
 *   - codemode.double(7) → empty/undefined result
 *
 * Expected after fix: codemode.double(7) returns 14 in the SAME turn.
 *
 * This script speaks the real WebSocket protocol to the live dev server,
 * sends one chat message that exercises the bug, collects every frame,
 * and reports the exact tool-output result. No prose claims — the exit
 * code and transcript prove success or failure.
 */

import { appendFileSync, writeFileSync } from 'node:fs';

const BASE_URL = process.env.PROTEUS_BASE_URL ?? 'http://localhost:5173';
const AGENT_NAME = 'repro-' + Date.now();
const TRANSCRIPT = process.env.PROTEUS_TRANSCRIPT ?? '/tmp/repro-transcript.txt';
const TIMEOUT_MS = 180_000;

const allFrames: unknown[] = [];

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
    ws.onerror = (e) => { clearTimeout(t); reject(new Error('WS error: ' + JSON.stringify(e))); };
    ws.onmessage = (e) => {
      try { allFrames.push(JSON.parse(String(e.data))); } catch { allFrames.push(String(e.data)); }
    };
  });
}

async function chat(ws: WebSocket, text: string, timeoutMs = TIMEOUT_MS): Promise<{ bodies: string[] }> {
  return new Promise((resolve, reject) => {
    const reqId = uid();
    const timer = setTimeout(() => reject(new Error('chat timeout')), timeoutMs);
    const bodies: string[] = [];
    let done = false;
    const finish = () => { clearTimeout(timer); ws.removeEventListener('message', handler); resolve({ bodies }); };
    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'cf_agent_use_chat_response' && msg.id === reqId) {
          if (msg.body) bodies.push(msg.body);
          if (msg.done && !msg.error) { done = true; setTimeout(() => { if (done) finish(); }, 2500); }
          if (msg.error) { clearTimeout(timer); ws.removeEventListener('message', handler); reject(new Error('chat error: ' + msg.body)); }
        }
      } catch {}
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({
      type: 'cf_agent_use_chat_request',
      id: reqId,
      init: { method: 'POST', body: JSON.stringify({ messages: [{ id: uid(), role: 'user', parts: [{ type: 'text', text }] }] }) },
    }));
  });
}

async function main() {
  writeFileSync(TRANSCRIPT, `=== Same-turn bug repro ===\nagent=${AGENT_NAME}\nbase=${BASE_URL}\nstart=${new Date().toISOString()}\n\n`);

  const pf = await fetch(`${BASE_URL}/`);
  log(`preflight: ${pf.status}`);
  if (pf.status !== 200) { log('FAIL: server not responsive'); process.exit(1); }

  log('WS connect...');
  const ws = await connect();
  log('  connected');

  // Single user message that exercises the bug: create tool + invoke in same turn.
  log('\n--- Single turn: create and invoke ---');
  const prompt =
    'Do EXACTLY these two steps in a single assistant turn:\n' +
    'Step 1: Call execute_tools with code:\n' +
    '  async () => { return await workspace.createTool("double", "doubles a number", "async (n) => n * 2"); }\n' +
    'Step 2: After step 1 completes, call execute_tools again with code:\n' +
    '  async () => { return await codemode.double(7); }\n' +
    'Then reply with just the number from step 2.';

  const r = await chat(ws, prompt);
  const body = r.bodies.join('');
  log(`body length: ${body.length} chars`);

  // Extract tool-output frames. Each WS frame is
  //   { type: "cf_agent_use_chat_response", id, body: "<stringified JSON>", done }
  // where body is itself a stream-encoded object like
  //   {"type":"tool-output-available","toolCallId":"...","output":{...}}
  // We parse body directly — it's plain JSON.
  const toolOutputs: Array<{ input?: string; result?: unknown; error?: unknown; raw: string }> = [];
  const toolInputs: Array<{ input?: string; raw: string }> = [];
  for (const f of allFrames) {
    if (typeof f !== 'object' || f === null) continue;
    const outer = f as { body?: string };
    if (typeof outer.body !== 'string') continue;
    try {
      const inner = JSON.parse(outer.body);
      if (inner?.type === 'tool-output-available') {
        const output = inner.output ?? {};
        toolOutputs.push({
          input: typeof output.code === 'string' ? output.code : undefined,
          result: output.result,
          error: output.error,
          raw: outer.body,
        });
      } else if (inner?.type === 'tool-input-available') {
        toolInputs.push({
          input: typeof inner.input?.code === 'string' ? inner.input.code : undefined,
          raw: outer.body,
        });
      }
    } catch {}
  }

  log(`\nextracted ${toolInputs.length} tool-input(s):`);
  for (const [i, o] of toolInputs.entries()) {
    log(`  [${i}] code=${JSON.stringify(o.input?.slice(0, 150))}`);
  }

  log(`\nextracted ${toolOutputs.length} tool-output(s):`);
  for (const [i, o] of toolOutputs.entries()) {
    log(`  [${i}] code=${JSON.stringify(o.input?.slice(0, 100))}`);
    log(`       result=${JSON.stringify(o.result)} error=${JSON.stringify(o.error)}`);
  }

  // The key assertion: the SECOND execute_tools call must return 14 (from codemode.double(7))
  // or include a clear error. If result is undefined with no error, that's the exact bug.
  let secondResult: unknown = undefined;
  let secondError: unknown = undefined;
  let secondCode: string | undefined;
  for (const o of toolOutputs) {
    if (o.input && o.input.includes('codemode.double')) {
      secondResult = o.result;
      secondError = o.error;
      secondCode = o.input;
      break;
    }
  }

  log(`\ncodemode.double call found: ${secondCode !== undefined}`);
  log(`codemode.double result: ${JSON.stringify(secondResult)}`);
  log(`codemode.double error: ${JSON.stringify(secondError)}`);

  const ok = secondResult === 14 || secondResult === '14';
  log(`\nresult equals 14: ${ok}`);
  log(`end=${new Date().toISOString()}`);

  ws.close();
  if (!ok) {
    log('\nREPRO CONFIRMED: same-turn codemode.<name> does NOT return the expected value.');
    process.exit(2);
  }
  log('\nPASS: same-turn codemode.<name> works correctly.');
  process.exit(0);
}

main().catch(e => {
  log(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  log((e as Error).stack ?? '');
  process.exit(99);
});
