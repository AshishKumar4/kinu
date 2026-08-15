// Headless think-tool test driver against the STAGING deployment
// (proteus-staging.*.workers.dev — dev identity, no CF Access).
//
// Drives a real chat turn over the agents-SDK WebSocket protocol
// (cf_agent_use_chat_request) and prints live streaming progress + a frame
// histogram + the final assistant text, so we can observe whether
// think({strategy:'heads'|'mcts'}) actually works end-to-end (and where it hangs).
//
//   bun scripts/staging-think-test.ts "<agent-name>" "<prompt>" [listenSeconds]

import * as v from 'valibot';

const streamEventSchema = v.looseObject({
  type: v.string(),
  delta: v.optional(v.string()),
  toolName: v.optional(v.string()),
});

const chatPartSchema = v.looseObject({
  type: v.string(),
  text: v.optional(v.string()),
});

const chatMessageSchema = v.looseObject({
  role: v.string(),
  parts: v.array(chatPartSchema),
});

const frameSchema = v.looseObject({
  type: v.string(),
  body: v.optional(v.string()),
  messages: v.optional(v.array(chatMessageSchema)),
});

const BASE = process.env.PROTEUS_BASE_URL ?? 'https://proteus-staging.ashishkmr472.workers.dev';
const AGENT = process.argv[2] ?? 'heads-test';
const PROMPT = process.argv[3] ?? 'Say hello.';
const LISTEN_MS = (Number(process.argv[4]) || 150) * 1000;

const wsUrl = BASE.replace(/^http/, 'ws') + `/agents/orchestrator-agent/${AGENT}`;
const chatId = 'test-' + crypto.randomUUID().slice(0, 8);
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';

const ws = new WebSocket(wsUrl);
let opened = false;
const frameCounts: Record<string, number> = {};
let assistantText = '';
let lastActivity = Date.now();
const toolEvents: string[] = [];
const errors: string[] = [];

function note(label: string, msg: string) { console.log(`[${el()}] ${label} ${msg}`); lastActivity = Date.now(); }

// Parse one SSE-style stream chunk (AI SDK v6 UI-message-stream: `data: {json}` lines).
function handleStreamChunk(chunk: string) {
  for (const line of chunk.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let decoded;
    try { decoded = JSON.parse(payload); } catch { continue; }
    const parsed = v.safeParse(streamEventSchema, decoded);
    if (!parsed.success) continue;
    const event = parsed.output;
    const ty = event.type;
    if (ty === 'text-delta' && event.delta !== undefined) { assistantText += event.delta; lastActivity = Date.now(); }
    else if (ty === 'reasoning-delta') { lastActivity = Date.now(); }
    else if (ty.startsWith('tool-')) {
      const tag = `${ty}${event.toolName ? ':' + event.toolName : ''}`;
      if (!toolEvents.includes(tag)) { toolEvents.push(tag); note('  ⚙', tag); }
    } else if (ty === 'error') { const m = JSON.stringify(event).slice(0, 300); errors.push(m); note('  ✗ STREAM ERROR', m); }
    else if (ty === 'finish' || ty === 'finish-step') { note('  ✓', ty); }
  }
}

ws.addEventListener('open', () => {
  opened = true;
  note('WS', `open → ${wsUrl}`);
  const body = JSON.stringify({
    id: chatId,
    messages: [{ id: 'um-' + crypto.randomUUID().slice(0, 8), role: 'user', parts: [{ type: 'text', text: PROMPT }] }],
    trigger: 'submit-message',
  });
  ws.send(JSON.stringify({ type: 'cf_agent_use_chat_request', id: chatId, init: { method: 'POST', body } }));
  note('→', `sent chat request (chatId=${chatId})`);
  console.log(`         prompt: ${PROMPT}`);
});

ws.addEventListener('message', (ev) => {
  const messageData = v.safeParse(v.string(), ev.data);
  if (!messageData.success || messageData.output.length === 0) return;
  let decoded;
  try { decoded = JSON.parse(messageData.output); } catch { return; }
  const parsed = v.safeParse(frameSchema, decoded);
  if (!parsed.success) return;
  const data = parsed.output;
  const type = data.type;
  frameCounts[type] = (frameCounts[type] ?? 0) + 1;
  if (frameCounts[type] === 1) note('·', `first frame: ${type}`);
  if (type === 'cf_agent_use_chat_response' && data.body !== undefined) handleStreamChunk(data.body);
  else if (type === 'cf_agent_chat_messages') {
    for (const m of (data.messages ?? [])) {
      for (const p of m.parts) {
        const blob = JSON.stringify(p);
        if (/error|aborted|budget|Merge synthesis|reading 'input'/i.test(blob)) note('  ■', `[${m.role}/${p.type}] ${blob.slice(0, 400)}`);
        if (p.type === 'text' && m.role === 'assistant' && p.text !== undefined && p.text.length > assistantText.length) assistantText = p.text;
      }
    }
  }
});

ws.addEventListener('error', (e) => note('WS', `error: ${JSON.stringify(e).slice(0, 200)}`));
ws.addEventListener('close', (e) => note('WS', `close code=${e.code}`));

const hb = setInterval(() => {
  const idle = ((Date.now() - lastActivity) / 1000).toFixed(0);
  console.log(`[${el()}] ♥ heartbeat — frames=${JSON.stringify(frameCounts)} textLen=${assistantText.length} idle=${idle}s`);
}, 20000);

setTimeout(() => {
  clearInterval(hb);
  console.log(`\n[${el()}] ===== SUMMARY =====`);
  console.log(`opened=${opened}  frames=${JSON.stringify(frameCounts)}`);
  console.log(`toolEvents=${JSON.stringify(toolEvents)}`);
  console.log(`errors=${errors.length ? JSON.stringify(errors) : 'none'}`);
  console.log(`assistantText (${assistantText.length} chars):\n${assistantText.slice(0, 2000) || '(none)'}`);
  try { ws.close(); } catch {}
  process.exit(0);
}, LISTEN_MS);
