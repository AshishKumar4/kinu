#!/usr/bin/env bun
/**
 * Phase A+B+C empirical test — preamble-injection pattern.
 *
 * User scenario: "Create a tool called readAndSummarize that reads a file
 * and returns its first 50 chars. Write /tmp/test.txt with 'Hello World'.
 * Then use readAndSummarize on /tmp/test.txt."
 *
 * Must succeed in a SINGLE user turn:
 *   Step 1: workspace.createTool("readAndSummarize", ..., "async ({path}) => (await workspace.readFile(path)).slice(0,50)")
 *   Step 2: workspace.writeFile("/tmp/test.txt", "Hello World")
 *   Step 3: codemode.readAndSummarize({path: "/tmp/test.txt"})
 *
 * Phase C is verified: tool body INSIDE the sandbox calls `workspace.readFile`.
 * No "workspace is not defined" errors. No empty {} tool outputs.
 */

import { appendFileSync, writeFileSync } from 'node:fs';

const BASE_URL = process.env.PROTEUS_BASE_URL ?? 'http://localhost:5173';
const AGENT_NAME = 'phaseabc-' + Date.now();
const TRANSCRIPT = '/tmp/phase-abc-transcript.txt';
const TIMEOUT_MS = 240_000;

const allFrames: unknown[] = [];

function log(msg: string) { console.log(msg); appendFileSync(TRANSCRIPT, msg + '\n'); }
function uid() { return Math.random().toString(36).slice(2, 10); }
function wsUrl() { const u = new URL(BASE_URL); u.protocol = 'ws:'; return `${u.origin}/agents/orchestrator-agent/${AGENT_NAME}`; }

async function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    const t = setTimeout(() => reject(new Error('WS connect timeout')), 10_000);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error('WS error: ' + JSON.stringify(e))); };
    ws.onmessage = (e) => { try { allFrames.push(JSON.parse(String(e.data))); } catch { allFrames.push(String(e.data)); } };
  });
}

async function chat(ws: WebSocket, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const reqId = uid();
    const timer = setTimeout(() => reject(new Error('chat timeout')), TIMEOUT_MS);
    let done = false;
    const finish = () => { clearTimeout(timer); ws.removeEventListener('message', handler); resolve(); };
    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'cf_agent_use_chat_response' && msg.id === reqId) {
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
  writeFileSync(TRANSCRIPT, `=== Phase A+B+C repro ===\nagent=${AGENT_NAME}\nbase=${BASE_URL}\nstart=${new Date().toISOString()}\n\n`);

  const pf = await fetch(`${BASE_URL}/`);
  log(`preflight: ${pf.status}`);
  if (pf.status !== 200) { log('FAIL: server not responsive'); process.exit(1); }

  const ws = await connect();
  log('WS connected');

  const prompt =
    'Do EXACTLY these three steps in a single assistant turn using execute_tools:\n' +
    'Step 1: Call execute_tools with code:\n' +
    '  async () => { return await workspace.createTool("readAndSummarize", "reads a file and returns first 50 chars", "async ({path}) => (await workspace.readFile(path)).slice(0,50)"); }\n' +
    'Step 2: Call execute_tools with code:\n' +
    '  async () => { return await workspace.writeFile("/tmp/test.txt", "Hello World"); }\n' +
    'Step 3: Call execute_tools with code:\n' +
    '  async () => { return await tools.readAndSummarize({path: "/tmp/test.txt"}); }\n' +
    'Reply with just the Step 3 result string on a single line.\n' +
    'Note: newly-saved crafted tools are callable as tools.<name>(args) in subsequent execute_tools steps.';

  log('\n--- sending prompt ---');
  log(prompt);
  await chat(ws, prompt);

  // Parse frames
  const toolInputs: Array<{ input?: string; toolCallId?: string }> = [];
  const toolOutputs: Array<{ toolCallId?: string; code?: string; result?: unknown; error?: unknown }> = [];
  const toolErrors: Array<{ toolCallId?: string; errorText?: string }> = [];

  for (const f of allFrames) {
    if (typeof f !== 'object' || f === null) continue;
    const outer = f as { body?: string; type?: string };
    if (typeof outer.body !== 'string') continue;
    try {
      const inner = JSON.parse(outer.body);
      if (inner?.type === 'tool-input-available') {
        toolInputs.push({ input: typeof inner.input?.code === 'string' ? inner.input.code : undefined, toolCallId: inner.toolCallId });
      } else if (inner?.type === 'tool-output-available') {
        const output = inner.output ?? {};
        toolOutputs.push({
          toolCallId: inner.toolCallId,
          code: typeof output.code === 'string' ? output.code : undefined,
          result: output.result,
          error: output.error,
        });
      } else if (inner?.type === 'tool-output-error') {
        toolErrors.push({ toolCallId: inner.toolCallId, errorText: inner.errorText });
      }
    } catch {}
  }

  log(`\nextracted ${toolInputs.length} tool-input(s):`);
  for (const [i, o] of toolInputs.entries()) {
    log(`  [${i}] code=${JSON.stringify(o.input?.slice(0, 160))}`);
  }

  log(`\nextracted ${toolOutputs.length} tool-output(s):`);
  for (const [i, o] of toolOutputs.entries()) {
    log(`  [${i}] code=${JSON.stringify(o.code?.slice(0, 100))}`);
    log(`       result=${JSON.stringify(o.result)}`);
    log(`       error=${JSON.stringify(o.error)}`);
  }

  log(`\nextracted ${toolErrors.length} tool-error(s):`);
  for (const [i, e] of toolErrors.entries()) {
    log(`  [${i}] errorText=${JSON.stringify(e.errorText?.slice(0, 300))}`);
  }

  // Assertions
  const allJson = JSON.stringify(allFrames);
  const hasCodegen = allJson.includes('Code generation from strings disallowed');
  log(`\n'Code generation from strings disallowed' in any frame: ${hasCodegen}`);
  const hasWorkspaceUndefined = allJson.includes('workspace is not defined');
  log(`'workspace is not defined' in any frame: ${hasWorkspaceUndefined}`);

  // Find the readAndSummarize invocation output (the Step 3 call, not Step 1's createTool)
  const summarizeOutput = toolOutputs.find(o => {
    if (!o.code) return false;
    const c = o.code;
    // Match the invocation pattern "tools.readAndSummarize" or "codemode.readAndSummarize"
    // while excluding the createTool registration call (which also contains the string).
    return (c.includes('tools.readAndSummarize') || c.includes('codemode.readAndSummarize'))
      && !c.includes('workspace.createTool');
  });
  log(`\nreadAndSummarize invocation output: ${JSON.stringify(summarizeOutput?.result)}`);
  const summarizeOk = typeof summarizeOutput?.result === 'string' && summarizeOutput.result.startsWith('Hello World');
  log(`readAndSummarize returned 'Hello World': ${summarizeOk}`);

  ws.close();
  log(`\nend=${new Date().toISOString()}`);

  if (hasCodegen || hasWorkspaceUndefined || !summarizeOk) {
    log('\nFAIL');
    process.exit(2);
  }
  log('\nPASS');
  process.exit(0);
}

main().catch(e => {
  log(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(99);
});
