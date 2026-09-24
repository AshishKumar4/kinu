// Every completed LLM step must be durable when it completes: the real turn engine and a real
// sqlite RunEventRecorder through the same `TurnAccumulator` sink both backends construct.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scratchPath, testActorHandle } from '@kinu.run/test-utils';
import { stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { runChat, INTERRUPTED_TURN, type ChatEvent } from '../src/chat';
import { createChatModel } from '../src/llm';
import { initRunEventTables, RunEventRecorder } from '../src/events/recorder';
import { decodeModelMessageValues } from '../src/session/message-codec';
import { TurnAccumulator, type StepLike } from '../src/orchestrator/turn-accumulator';
import { TurnContextMeter } from '../src/context-meter';
import { makeSql, makeExecRaw } from './helpers';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

function sse(events: string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join('');
}

function toolStep(id: string, command: string): Response {
  return new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: `about to ${command}` } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command }) } },
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
  shell: tool({
    description: 'shell',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }: { command: string }) => `ran: ${command}`,
  }),
};

function scriptedProvider(script: ReadonlyArray<() => Response>) {
  let call = 0;
  const arrivals: Array<{ at: number; resolve: () => void }> = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.json();
      const at = Math.min(call, script.length - 1);
      call += 1;

      for (const waiter of arrivals.filter((w) => w.at <= call)) waiter.resolve();

      return script[at]?.() ?? textStep('done');
    },
  });

  return {
    requests: () => call,
    /** Settles once the server has received its `n`th request. */
    requested: (n: number): Promise<void> => {
      if (call >= n) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      arrivals.push({ at: n, resolve });

      return promise;
    },
    model: createChatModel({
      kind: 'openai-compat', name: 'openrouter',
      baseURL: `http://localhost:${server.port}/v1`,
      headers: { Authorization: 'Bearer test' }, modelId: 'test-model',
    }),
    stop: () => server.stop(true),
  };
}

/** A file-backed database: durability against an in-memory database proves nothing. */
function workspaceOnDisk() {
  // A sqlite file strands its -wal and -shm siblings, so it gets its own directory.
  const path = scratchPath('step-persistence', 'store.sqlite');
  const db = new Database(path);
  initRunEventTables(makeExecRaw(db));

  return { path, db, sql: makeSql(db) };
}

/** The wiring each backend does: one accumulator whose `onStepEvent` sink is the durable recorder. */
function backendWiring(recorder: RunEventRecorder, runId: string) {
  const acc = new TurnAccumulator({
    onStepEvent: (ev) => { recorder.emit(runId, { type: 'step_finish', ...ev }); },
  });

  acc.reset(Date.now());

  return acc;
}

/** Drive one turn as the CLI loop does; `cutAfterSteps` interrupts after that many finished steps. */
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
      tools, stopWhen: stepCountIs(20), signal: abort.signal,
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
    .flatMap((e) => e.type === 'step_finish' ? [{ ...e, messages: decodeModelMessageValues(e.messages ?? []) }] : []);
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
      const recorder = new RunEventRecorder(sql, testActorHandle(sql));
      const acc = backendWiring(recorder, 'run-1');

      const witness: Array<{ requests: number; recordedSteps: number }> = [];
      const abort = new AbortController();

      for await (const ev of runChat({
        model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }],
        tools, stopWhen: stepCountIs(20), signal: abort.signal,
      })) {
        if (ev.type !== 'step-finish') continue;
        acc.recordStep({ response: { messages: ev.responseMessages } });
        const recordedSteps = stepRows(recorder, 'run-1').filter((r) => (r.messages ?? []).length > 0).length;
        witness.push({ requests: provider.requests(), recordedSteps });
      }

      expect(witness.map((w) => w.recordedSteps)).toEqual([1, 2, 3]);
      expect(witness.map((w) => w.requests)).toEqual([1, 2, 3]);
    } finally {
      await provider.stop();
      db.close();
    }
  });

  test('a turn cut after step 2 leaves steps 1..2 durable and correctly paired', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => toolStep('call_b', 'git diff'),
      () => textStep('never reached'),
    ]);

    const { db, sql } = workspaceOnDisk();

    try {
      const recorder = new RunEventRecorder(sql, testActorHandle(sql));
      const acc = backendWiring(recorder, 'run-cut');
      const run = await drive({ model: provider.model, acc, cutAfterSteps: 2 });

      expect(run.threw).toBe('The turn was interrupted before it finished.');

      const rows = stepRows(recorder, 'run-cut');
      expect(rows.map((r) => r.stepIndex)).toEqual([1, 2]);

      for (const row of rows) {
        const calls = pairing(row.messages ?? []);
        expect(calls.length).toBe(1);
        expect(calls[0]?.settled).toBe(true);
      }

      expect(rows.flatMap((r) => pairing(r.messages ?? []).map((c) => c.id))).toEqual(['call_a', 'call_b']);

      const transcript = recorder.transcript('run-cut');
      expect(pairing(transcript).every((c) => c.settled)).toBe(true);
      expect(transcript.length).toBe(4);
    } finally {
      await provider.stop();
      db.close();
    }
  });

  test('the durable rows survive the process: a fresh recorder over the same file reads them', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => toolStep('call_b', 'git diff'),
      () => textStep('never reached'),
    ]);

    const { path, db, sql } = workspaceOnDisk();

    try {
      const acc = backendWiring(new RunEventRecorder(sql, testActorHandle(sql)), 'run-killed');
      await drive({ model: provider.model, acc, cutAfterSteps: 2 });
      // The process ends here: nothing ever wrote the turn's messages to the backend's message store.
      db.close();

      const reopened = new Database(path);

      try {
        const reopenedSql = makeSql(reopened);
        const after = new RunEventRecorder(reopenedSql, testActorHandle(reopenedSql));
        const transcript = after.transcript('run-killed');
        expect(pairing(transcript).map((c) => c.id)).toEqual(['call_a', 'call_b']);
        expect(pairing(transcript).every((c) => c.settled)).toBe(true);
        expect(stepRows(after, 'run-killed').map((r) => r.stepIndex)).toEqual([1, 2]);
      } finally {
        reopened.close();
      }
    } finally {
      await provider.stop();
    }
  });

  test('a provider throw mid-turn keeps the steps that finished', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      // Terminal failure: a 5xx would be retried by the SDK before it throws.
      () => new Response('{"error":{"message":"upstream refused the request"}}', { status: 400, headers: { 'content-type': 'application/json' } }),
    ]);

    const { db, sql } = workspaceOnDisk();

    try {
      const recorder = new RunEventRecorder(sql, testActorHandle(sql));
      const acc = backendWiring(recorder, 'run-threw');
      const run = await drive({ model: provider.model, acc });

      expect(run.threw).not.toBeNull();
      expect(run.history).toEqual([]);
      const transcript = recorder.transcript('run-threw');
      expect(pairing(transcript).map((c) => c.id)).toEqual(['call_a']);
      expect(pairing(transcript).every((c) => c.settled)).toBe(true);
    } finally {
      await provider.stop();
      db.close();
    }
  });
});

describe('the durable record and the history the caller persists are one construction', () => {
  test('a completed turn: the log transcript IS done.responseMessages', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => textStep('all clean'),
    ]);

    const { db, sql } = workspaceOnDisk();

    try {
      const recorder = new RunEventRecorder(sql, testActorHandle(sql));
      const acc = backendWiring(recorder, 'run-same');
      const run = await drive({ model: provider.model, acc });

      expect(run.threw).toBeNull();
      expect(run.history.length).toBeGreaterThan(0);
      expect(recorder.transcript('run-same')).toEqual(run.history);
    } finally {
      await provider.stop();
      db.close();
    }
  });

  test('a cut turn: the log holds every COMPLETED step, and history adds only the step the cut interrupted', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => toolStep('call_b', 'git diff'),
      () => textStep('never reached'),
    ]);

    const { db, sql } = workspaceOnDisk();

    try {
      const recorder = new RunEventRecorder(sql, testActorHandle(sql));
      const acc = backendWiring(recorder, 'run-cut-tail');
      // Step 2 has not finished, so the SDK never reports it as a step row.
      const abort = new AbortController();
      const history: ModelMessage[] = [];
      let calls = 0;

      const cutTurn = async (): Promise<void> => {
        for await (const ev of runChat({
          model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }],
          tools, stopWhen: stepCountIs(20), signal: abort.signal,
        })) {
          if (ev.type === 'step-finish') acc.recordStep({ response: { messages: ev.responseMessages } });

          if (ev.type === 'tool-call') {
            calls += 1;

            if (calls === 2) abort.abort();
          }

          if (ev.type === 'done') history.push(...ev.responseMessages);
        }
      };

      await expect(cutTurn()).rejects.toThrow(INTERRUPTED_TURN);

      const transcript = recorder.transcript('run-cut-tail');
      expect(pairing(transcript).map((c) => c.id)).toEqual(['call_a']);
      expect(history.slice(0, transcript.length)).toEqual(transcript);
      expect(pairing(history).map((c) => c.id)).toEqual(['call_a', 'call_b']);
      expect(pairing(history).every((c) => c.settled)).toBe(true);
    } finally {
      await provider.stop();
      db.close();
    }
  });
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
      const recorder = new RunEventRecorder(sql, testActorHandle(sql));
      const acc = backendWiring(recorder, 'run-dedupe');
      const run = await drive({ model: provider.model, acc });

      const rows = stepRows(recorder, 'run-dedupe');
      expect(rows.map((r) => r.stepIndex)).toEqual([1, 2, 3, 4]);
      expect(recorder.transcript('run-dedupe')).toEqual(run.history);
      const perRow = rows.map((r) => (r.messages ?? []).length);
      expect(perRow.reduce((a, b) => a + b, 0)).toBe(run.history.length);
      expect(pairing(run.history).map((c) => c.id)).toEqual(['call_a', 'call_b', 'call_c']);
    } finally {
      await provider.stop();
      db.close();
    }
  });

  test('a re-driven turn writes a second record, never a doubled first one', async () => {
    const script = [() => toolStep('call_a', 'a'), () => textStep('done')];
    const first = scriptedProvider(script);
    const second = scriptedProvider(script);
    const { db, sql } = workspaceOnDisk();

    try {
      const recorder = new RunEventRecorder(sql, testActorHandle(sql));
      const one = await drive({ model: first.model, acc: backendWiring(recorder, 'run-x') });
      const two = await drive({ model: second.model, acc: backendWiring(recorder, 'run-y') });

      // The accumulator's durable cursor resets with the turn.
      expect(stepRows(recorder, 'run-x').map((r) => r.stepIndex)).toEqual([1, 2]);
      expect(stepRows(recorder, 'run-y').map((r) => r.stepIndex)).toEqual([1, 2]);
      expect(recorder.transcript('run-x')).toEqual(one.history);
      expect(recorder.transcript('run-y')).toEqual(two.history);
      expect(pairing(recorder.transcript('run-y')).map((c) => c.id)).toEqual(['call_a']);
    } finally {
      await first.stop();
      await second.stop();
      db.close();
    }
  });

  test('a step boundary reporting no response array cannot rewind the cursor', () => {
    // A scaffold-authored step has no SDK response array; treating it as empty would make the next step re-record everything.
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

// #27. The Activity tab reads the newest step's breakdown of the request it sent. The model runs ahead
// of a reader that does I/O per event (the page's own relay drains the stream), so the next step's
// request is prepared before this step is recorded.
describe('a step records the breakdown of the request it sent', () => {
  test('with the reader behind the model, every step keeps its own breakdown', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => textStep('all clean'),
    ]);

    const { db, sql } = workspaceOnDisk();

    try {
      const recorder = new RunEventRecorder(sql, testActorHandle(sql));
      const acc = backendWiring(recorder, 'run-meter');
      const abort = new AbortController();
      let finished = 0;

      for await (const ev of runChat({
        model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }],
        tools, stopWhen: stepCountIs(20), signal: abort.signal,
        meter: new TurnContextMeter(),
        observeStream: async (stream) => { for await (const part of stream) void part; },
      })) {
        if (ev.type !== 'step-finish') continue;
        finished += 1;

        if (finished === 1) await provider.requested(2);
        acc.recordStep({
          response: { messages: ev.responseMessages },
          ...(ev.usage && { usage: ev.usage }),
          ...(ev.context && { context: ev.context }),
        });
      }

      const measured = stepRows(recorder, 'run-meter').map((row) => row.context?.measuredChars);

      expect(measured).toHaveLength(2);
      expect(measured.every((chars) => chars !== undefined)).toBe(true);
      // The second request carries the first step's call and its result, so it is the larger.
      expect(measured[1]).toBeGreaterThan(measured[0] ?? Infinity);
    } finally {
      await provider.stop();
      db.close();
    }
  });
});
