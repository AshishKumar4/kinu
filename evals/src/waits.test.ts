import { expect, test } from 'bun:test';
import type { RunEvent } from '@kinu.run/core';
import { measureWaits } from './results';

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

/** A finished tool call as the ledger records it. */
function call(at: number, recorded: Pick<ToolCallEnd, 'name' | 'args' | 'durationMs' | 'result'>): RunEvent {
  return { type: 'tool_call_end', runId: 'trial-run', eventIndex: at, timestamp: '2026-10-19T19:00:00Z', toolCallId: `call-${String(at)}`, ...recorded };
}

const handle = (kind: string, message: string) => ({ background: true, jobId: `bgjob-${kind}`, kind, message });

const WINDOW = 'Outran the 30s foreground window; backgrounded: still running, not cancelled. The settled result will wake you.';

const PERSON = 'The person wrote while this ran; backgrounded: still running, not cancelled. The settled result will wake you.';

// Main's report on rc22 (2026-10-20): a program that stalled 30 s and became a job still let its task pass, so a grade
// cannot see where the harness made the agent wait.
test('a trial names each shell command or program that became a job, what moved it, and its slowest calls', () => {
  const waits = measureWaits([
    { actor: 'main', events: [
      call(1, { name: 'shell', args: { command: 'setsid -f chromium http://127.0.0.1:3000' }, durationMs: 30_064, result: handle('shell', WINDOW) }),
      call(2, { name: 'eval', args: { code: 'return await workspace.slates.chat.probeAsk({ q: "ok" });' }, durationMs: 120_800, result: 'PROBE_OK' }),
      // A spawn hands back its job at once, by design: no wait.
      call(3, { name: 'agents', args: { op: 'swarm' }, durationMs: 230, result: handle('spawn', 'Started.') }),
      call(4, { name: 'file', args: { op: 'read', path: '/a' }, durationMs: 12, result: 'text' }),
    ] },
    { actor: 'subagent-1', events: [call(5, { name: 'eval', args: { code: 'execFile("npx", ["tsc"])' }, durationMs: 9_000, result: handle('eval', PERSON) })] },
  ]);

  expect(waits).toEqual({
    backgrounded: [
      { actor: 'main', tool: 'shell', ran: 'setsid -f chromium http://127.0.0.1:3000', wallMs: 30_064, by: 'window' },
      { actor: 'subagent-1', tool: 'eval', ran: 'execFile("npx", ["tsc"])', wallMs: 9_000, by: 'person' },
    ],
    slowest: [
      { actor: 'main', tool: 'eval', ran: 'return await workspace.slates.chat.probeAsk({ q: "ok" });', wallMs: 120_800 },
      { actor: 'main', tool: 'shell', ran: 'setsid -f chromium http://127.0.0.1:3000', wallMs: 30_064 },
      { actor: 'subagent-1', tool: 'eval', ran: 'execFile("npx", ["tsc"])', wallMs: 9_000 },
      { actor: 'main', tool: 'agents', ran: '{"op":"swarm"}', wallMs: 230 },
      { actor: 'main', tool: 'file', ran: '{"op":"read","path":"/a"}', wallMs: 12 },
    ],
    // The program a wake's turn held for 120.8 s, 90.8 s past what a person-watched turn waits; the shell 64 ms.
    pastInteractiveMs: 90_864,
  });
});
