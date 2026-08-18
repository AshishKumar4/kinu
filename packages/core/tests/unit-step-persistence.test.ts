// Every completed LLM step must be durable at the moment it completes.
//
// Before this, the model's own output first reached disk once per turn: the CLI
// appended `done.responseMessages` to live history and wrote flat text at
// `persist()`; the cf backend let Think save the transcript at turn end. So a
// turn that never reached its end — a process kill, a DO eviction, a provider
// throw — left every step it HAD finished nowhere on disk, while `run_events`
// (which read-models/runs.ts calls "the only history of what a turn did")
// carried step rows with token counts and no content at all.
//
// These tests drive the REAL turn engine against a local scripted provider (no
// live model calls) wired to a REAL sqlite-backed RunEventRecorder through the
// SAME `TurnAccumulator` sink both backends construct, and assert the four
// things that make per-step durability real:
//
//   1. a step's assistant parts and its tool results are on disk before the
//      next request is issued;
//   2. they survive the process — re-read through a FRESH recorder over the
//      same database file, which is what a restart actually does;
//   3. pairing holds inside every row, so the durable rows concatenate into a
//      request the SDK will assemble (the sibling ticket's invariant);
//   4. nothing is written twice — not across steps of one turn, not when the
//      same turn is re-driven.
//
// Cut the wire — drop `stepEvent.messages` in turn-accumulator.ts, or
// `responseMessages` from the step-finish ChatEvent in chat.ts — and tests 1-4
// fail naming the missing step.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scratchPath } from '@proteus/test-utils';
import { tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { runChat, INTERRUPTED_TURN, type ChatEvent } from '../src/chat.ts';
import { createChatModel } from '../src/llm.ts';
import { initRunEventTables, RunEventRecorder } from '../src/events/recorder.ts';
import { TurnAccumulator, type StepLike } from '../src/orchestrator/turn-accumulator.ts';
import { makeSql, makeExecRaw } from './helpers.ts';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

function sse(events: string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join('');
}

/** One `run` call, finishing on tool_calls — a step that continues the turn. */
function toolStep(id: string, command: string): Response {
  return new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: `about to ${command}` } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id, type: 'function', function: { name: 'run', arguments: JSON.stringify({ command }) } },
    ] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    '[DONE]',
  ]), { headers: SSE_HEADERS });
}

function textStep(text: string): Response {
  return new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 } }),
    '[DONE]',
  ]), { headers: SSE_HEADERS });
}

const tools: ToolSet = {
  run: tool({
    description: 'shell',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }: { command: string }) => `ran: ${command}`,
  }),
};

function scriptedProvider(script: ReadonlyArray<() => Response>) {
  let call = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.json();
      const at = Math.min(call, script.length - 1);
      call += 1;
      return script[at]?.() ?? textStep('done');
    },
  });
  return {
    requests: () => call,
    model: createChatModel({
      kind: 'openai-compat', name: 'openrouter',
      baseURL: `http://localhost:${server.port}/v1`,
      headers: { Authorization: 'Bearer test' }, modelId: 'test-model',
    }),
    stop: () => server.stop(true),
  };
}

/** A file-backed workspace database — a durability claim checked against an
 *  in-memory database proves nothing about surviving the process. */
function workspaceOnDisk() {
  // A sqlite file also strands its -wal and -shm siblings, so it gets a
  // directory of its own rather than a bare path under the temp root.
  const path = scratchPath('step-persistence', 'store.sqlite');
  const db = new Database(path);
  initRunEventTables(makeExecRaw(db));
  return { path, db, sql: makeSql(db) };
}

/**
 * The wiring a backend does, and nothing more: one accumulator whose
 * `onStepEvent` sink is the durable recorder. The CLI builds exactly this in
 * `local-session.ts` (`sinks.onStepEvent → recordRunEvent('step_finish')`) and
 * the cf DO in `actor-agent.ts` (`sinks.onStepEvent → eventRecorder.emit`).
 */
function backendWiring(recorder: RunEventRecorder, runId: string) {
  const acc = new TurnAccumulator({
    onStepEvent: (ev) => { recorder.emit(runId, { type: 'step_finish', ...ev }); },
  });
  acc.reset(Date.now());
  return acc;
}

/** Drive one turn, feeding every step-finish to the accumulator exactly as the
 *  CLI's turn loop does. `cutAfterSteps` interrupts the turn once that many
 *  steps have finished — a stop press, or the shape a kill lands in. */
async function drive({ model, acc, cutAfterSteps }: {
  model: LanguageModel;
  acc: TurnAccumulator;
  cutAfterSteps?: number;
}): Promise<{ events: ChatEvent[]; threw: string | null; history: ModelMessage[] }> {
  const abort = new AbortController();
  const events: ChatEvent[] = [];
  const history: ModelMessage[] = [];
  let threw: string | null = null;
  let finished = 0;
  try {
    for await (const ev of runChat({
      model, system: 'sys', history: [{ role: 'user', content: 'do the thing' }],
      tools, maxSteps: 20, signal: abort.signal,
    })) {
      events.push(ev);
      if (ev.type === 'step-finish') {
        const step: StepLike = { response: { messages: ev.responseMessages } };
        if (ev.usage) step.usage = ev.usage;
        acc.recordStep(step);
        finished += 1;
        if (cutAfterSteps !== undefined && finished >= cutAfterSteps) abort.abort();
      }
      if (ev.type === 'done') history.push(...ev.responseMessages);
    }
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  return { events, threw, history };
}

/** Every tool call in a message array, and whether its result is present. */
function pairing(messages: readonly ModelMessage[]): Array<{ id: string; name: string; settled: boolean }> {
  const settled = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) if (part.type === 'tool-result') settled.add(part.toolCallId);
  }
  const calls: Array<{ id: string; name: string; settled: boolean }> = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') calls.push({ id: part.toolCallId, name: part.toolName, settled: settled.has(part.toolCallId) });
    }
  }
  return calls;
}

function stepRows(recorder: RunEventRecorder, runId: string) {
  return recorder.read(runId, { limit: 100 })
    .flatMap((e) => e.type === 'step_finish' ? [e] : []);
}

describe('a completed step is durable at the moment it completes', () => {
  test('each step is on disk before the next request leaves the process', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => toolStep('call_b', 'git diff'),
      () => textStep('all clean'),
    ]);
    const { db, sql } = workspaceOnDisk();
    try {
      const recorder = new RunEventRecorder(sql);
      const acc = backendWiring(recorder, 'run-1');

      // Requests observed at each step boundary, against the rows already
      // durable that actually carry the model's output.
      const witness: Array<{ requests: number; recordedSteps: number }> = [];
      const abort = new AbortController();
      for await (const ev of runChat({
        model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }],
        tools, maxSteps: 20, signal: abort.signal,
      })) {
        if (ev.type !== 'step-finish') continue;
        acc.recordStep({ response: { messages: ev.responseMessages } });
        const recordedSteps = stepRows(recorder, 'run-1').filter((r) => (r.messages ?? []).length > 0).length;
        witness.push({ requests: provider.requests(), recordedSteps });
      }

      // Three steps, three requests, and at every boundary the step that just
      // finished was already durable WITH its output — the write is not deferred
      // to turn end.
      expect(witness.map((w) => w.recordedSteps)).toEqual([1, 2, 3]);
      expect(witness.map((w) => w.requests)).toEqual([1, 2, 3]);
    } finally {
      provider.stop();
      db.close();
    }
  }, 20_000);

  test('a turn cut after step 2 leaves steps 1..2 durable and correctly paired', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => toolStep('call_b', 'git diff'),
      () => textStep('never reached'),
    ]);
    const { db, sql } = workspaceOnDisk();
    try {
      const recorder = new RunEventRecorder(sql);
      const acc = backendWiring(recorder, 'run-cut');
      const run = await drive({ model: provider.model, acc, cutAfterSteps: 2 });

      // The turn did not finish, and says so.
      expect(run.threw).toBe('The turn was interrupted before it finished.');

      const rows = stepRows(recorder, 'run-cut');
      expect(rows.map((r) => r.stepIndex)).toEqual([1, 2]);

      // Each row carries the step's OWN output: one assistant message with the
      // step's tool call, and the tool message that answered it.
      for (const row of rows) {
        const calls = pairing(row.messages ?? []);
        expect(calls.length).toBe(1);
        expect(calls[0]?.settled).toBe(true);
      }
      expect(rows.flatMap((r) => pairing(r.messages ?? []).map((c) => c.id))).toEqual(['call_a', 'call_b']);

      // And the whole durable record assembles: every call in it is settled.
      const transcript = recorder.transcript('run-cut');
      expect(pairing(transcript).every((c) => c.settled)).toBe(true);
      expect(transcript.length).toBe(4);
    } finally {
      provider.stop();
      db.close();
    }
  }, 20_000);

  test('the durable rows survive the process: a fresh recorder over the same file reads them', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => toolStep('call_b', 'git diff'),
      () => textStep('never reached'),
    ]);
    const { path, db, sql } = workspaceOnDisk();
    try {
      const acc = backendWiring(new RunEventRecorder(sql), 'run-killed');
      await drive({ model: provider.model, acc, cutAfterSteps: 2 });
      // The process ends here: nothing in memory carries over, and nothing ever
      // wrote the turn's messages to the backend's message store.
      db.close();

      const reopened = new Database(path);
      try {
        const after = new RunEventRecorder(makeSql(reopened));
        const transcript = after.transcript('run-killed');
        expect(pairing(transcript).map((c) => c.id)).toEqual(['call_a', 'call_b']);
        expect(pairing(transcript).every((c) => c.settled)).toBe(true);
        expect(stepRows(after, 'run-killed').map((r) => r.stepIndex)).toEqual([1, 2]);
      } finally {
        reopened.close();
      }
    } finally {
      provider.stop();
    }
  }, 20_000);

  test('a provider throw mid-turn keeps the steps that finished', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => new Response('{"error":{"message":"upstream exploded"}}', { status: 500, headers: { 'content-type': 'application/json' } }),
    ]);
    const { db, sql } = workspaceOnDisk();
    try {
      const recorder = new RunEventRecorder(sql);
      const acc = backendWiring(recorder, 'run-threw');
      const run = await drive({ model: provider.model, acc });

      // The turn failed, and `done` never ran — so nothing appended to history.
      expect(run.threw).not.toBeNull();
      expect(run.history).toEqual([]);
      // The step that DID finish is still on disk, paired.
      const transcript = recorder.transcript('run-threw');
      expect(pairing(transcript).map((c) => c.id)).toEqual(['call_a']);
      expect(pairing(transcript).every((c) => c.settled)).toBe(true);
    } finally {
      provider.stop();
      db.close();
    }
  }, 20_000);
});

describe('the durable record and the history the caller persists are one construction', () => {
  test('a completed turn: the log transcript IS done.responseMessages', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => textStep('all clean'),
    ]);
    const { db, sql } = workspaceOnDisk();
    try {
      const recorder = new RunEventRecorder(sql);
      const acc = backendWiring(recorder, 'run-same');
      const run = await drive({ model: provider.model, acc });

      expect(run.threw).toBeNull();
      expect(run.history.length).toBeGreaterThan(0);
      expect(recorder.transcript('run-same')).toEqual(run.history);
    } finally {
      provider.stop();
      db.close();
    }
  }, 20_000);

  test('a cut turn: the log holds every COMPLETED step, and history adds only the step the cut interrupted', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => toolStep('call_b', 'git diff'),
      () => textStep('never reached'),
    ]);
    const { db, sql } = workspaceOnDisk();
    try {
      const recorder = new RunEventRecorder(sql);
      const acc = backendWiring(recorder, 'run-cut-tail');
      // Cut once the SECOND tool call is announced: step 2 has not finished, so
      // the SDK will never report it and it can never be a durable step row.
      const abort = new AbortController();
      const history: ModelMessage[] = [];
      let calls = 0;
      const cutTurn = async (): Promise<void> => {
        for await (const ev of runChat({
          model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }],
          tools, maxSteps: 20, signal: abort.signal,
        })) {
          if (ev.type === 'step-finish') acc.recordStep({ response: { messages: ev.responseMessages } });
          if (ev.type === 'tool-call') { calls += 1; if (calls === 2) abort.abort(); }
          if (ev.type === 'done') history.push(...ev.responseMessages);
        }
      };
      await expect(cutTurn()).rejects.toThrow(INTERRUPTED_TURN);

      const transcript = recorder.transcript('run-cut-tail');
      // Step 1 completed and is durable; step 2 never completed and is not.
      expect(pairing(transcript).map((c) => c.id)).toEqual(['call_a']);
      // The history the caller persists is the durable steps PLUS the cut step,
      // whose call the sibling invariant settled — so the record and the history
      // agree about step 1 and only differ by the step that never finished.
      expect(history.slice(0, transcript.length)).toEqual(transcript);
      expect(pairing(history).map((c) => c.id)).toEqual(['call_a', 'call_b']);
      expect(pairing(history).every((c) => c.settled)).toBe(true);
    } finally {
      provider.stop();
      db.close();
    }
  }, 20_000);
});

describe('ordering and idempotency', () => {
  test('no step is written twice: the rows partition the transcript', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'a'),
      () => toolStep('call_b', 'b'),
      () => toolStep('call_c', 'c'),
      () => textStep('done'),
    ]);
    const { db, sql } = workspaceOnDisk();
    try {
      const recorder = new RunEventRecorder(sql);
      const acc = backendWiring(recorder, 'run-dedupe');
      const run = await drive({ model: provider.model, acc });

      const rows = stepRows(recorder, 'run-dedupe');
      expect(rows.map((r) => r.stepIndex)).toEqual([1, 2, 3, 4]);
      // Each row's messages are disjoint and in order: concatenating them
      // reproduces the turn exactly once, with no message repeated.
      expect(recorder.transcript('run-dedupe')).toEqual(run.history);
      const perRow = rows.map((r) => (r.messages ?? []).length);
      expect(perRow.reduce((a, b) => a + b, 0)).toBe(run.history.length);
      expect(pairing(run.history).map((c) => c.id)).toEqual(['call_a', 'call_b', 'call_c']);
    } finally {
      provider.stop();
      db.close();
    }
  }, 20_000);

  test('a re-driven turn writes a second record, never a doubled first one', async () => {
    const script = [() => toolStep('call_a', 'a'), () => textStep('done')];
    const first = scriptedProvider(script);
    const second = scriptedProvider(script);
    const { db, sql } = workspaceOnDisk();
    try {
      const recorder = new RunEventRecorder(sql);
      const one = await drive({ model: first.model, acc: backendWiring(recorder, 'run-x') });
      const two = await drive({ model: second.model, acc: backendWiring(recorder, 'run-y') });

      // Each run's record is its own and complete: two steps each, and the
      // accumulator's durable cursor reset with the turn rather than carrying
      // the first run's four messages into the second run's first row.
      expect(stepRows(recorder, 'run-x').map((r) => r.stepIndex)).toEqual([1, 2]);
      expect(stepRows(recorder, 'run-y').map((r) => r.stepIndex)).toEqual([1, 2]);
      expect(recorder.transcript('run-x')).toEqual(one.history);
      expect(recorder.transcript('run-y')).toEqual(two.history);
      expect(pairing(recorder.transcript('run-y')).map((c) => c.id)).toEqual(['call_a']);
    } finally {
      first.stop();
      second.stop();
      db.close();
    }
  }, 20_000);

  test('a step boundary reporting no response array cannot rewind the cursor', () => {
    // The scaffold seam yields a step-finish for a scaffold-authored step, which
    // has no SDK response array behind it. Treating that as "the turn has
    // produced nothing" would make the next real step re-record everything.
    const recorded: Array<ReadonlyArray<ModelMessage> | undefined> = [];
    const acc = new TurnAccumulator({ onStepEvent: (ev) => { recorded.push(ev.messages); } });
    acc.reset(Date.now());

    const first: ModelMessage = { role: 'assistant', content: 'one' };
    const second: ModelMessage = { role: 'assistant', content: 'two' };
    acc.recordStep({ response: { messages: [first] } });
    acc.recordStep({ response: { messages: [] } });
    acc.recordStep({ response: { messages: [first, second] } });

    expect(recorded).toEqual([[first], undefined, [second]]);
  });
});
