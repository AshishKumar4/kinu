/**
 * A pending scaffold replayed against turns the session really recorded: the recording answers its model and tool
 * calls, nothing it does reaches the agent, and it passes only when every turn completes with an answer.
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import { initWorkspaceSchema, modifyScaffold, replayScaffold, type RecordedTurn } from '@kinu.run/core';
import { scratchDir, scratchPath, workspaceDatabase } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql, type CLIRuntime } from '../src/runtime';
import { LocalAgentSession } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const USAGE = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

/** The first turn computes with one `eval`, then answers; the second only answers. */
function recorder(): TestLanguageModelV2 {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async ({ prompt }: { prompt: LanguageModelV2Prompt }) => {
      // The newest user text the prompt holds names the turn; its own context rides as user messages too.
      const asked = prompt.flatMap((message) => (message.role === 'user' ? message.content : []))
        .flatMap((part) => (part.type === 'text' ? [part.text] : [])).filter((text) => text === 'What is one plus one?' || text === 'Say hello.').at(-1);

      const sum = asked === 'What is one plus one?';
      const computed = prompt.at(-1)?.role === 'tool';

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (sum && !computed) {
              controller.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName: 'eval', input: JSON.stringify({ code: 'return 1 + 1' }) });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: sum ? 'two' : 'hello there' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            }

            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

async function recorded(): Promise<{ readonly rt: CLIRuntime; readonly session: LocalAgentSession; readonly turns: RecordedTurn[] }> {
  const db = workspaceDatabase(scratchPath('scaffold-replay', 'agent.db'), { create: true });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' } });
  const session = new LocalAgentSession({ rt, db, model: recorder(), onEvent: () => {} });

  await session.send('What is one plus one?', { id: crypto.randomUUID() });
  await session.send('Say hello.', { id: crypto.randomUUID() });

  return { rt, session, turns: await session.recordedTurns() };
}

/** The scaffold rows and the decisions the run events recorded, oldest first. */
function scaffoldState(rt: CLIRuntime) {
  return {
    versions: rt.storage.sql<{ version: number; status: string }>`SELECT version, status FROM scaffold_versions ORDER BY version`,
    decisions: rt.storage.sql<{ type: string; payload: string }>`SELECT type, payload FROM run_events
      WHERE type IN ('scaffold_replayed', 'scaffold_promotion', 'scaffold_rollback') ORDER BY run_id, event_index`
      .map((row) => ({ type: row.type, ...v.parse(v.record(v.string(), v.unknown()), JSON.parse(row.payload)) })),
  };
}

describe('a pending scaffold replayed against recorded turns', () => {
  test('the session records each answered turn with the conversation it was asked in and what it produced', async () => {
    const { turns } = await recorded();

    expect(turns.map((turn) => turn.task)).toEqual(['What is one plus one?', 'Say hello.']);
    expect(turns[0]?.output.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(turns[1]?.input.filter((message) => message.role === 'user')).toHaveLength(2);
  });

  test('a scaffold that runs the default turn passes: the recording answers the model and its tool', async () => {
    const { rt, turns } = await recorded();

    expect(await replayScaffold(rt, 'async function run() { await host.defaultInference(); }', turns)).toBeNull();
  });

  test('a scaffold that makes the recorded tool call gets the recorded result, and passes', async () => {
    const { rt, turns } = await recorded();

    const source = `async function run() {
      const sum = await host.callTool('eval', { code: 'return 1 + 1' });
      await host.emit({ type: 'text_delta', text: 'the sum is ' + JSON.stringify(sum) });
    }`;

    expect(await replayScaffold(rt, source, turns.slice(0, 1))).toBeNull();
  });

  const failing = [
    { name: 'a throw', source: "async function run() { throw new Error('the loop broke'); }", failed: 'it threw: ' },
    {
      name: 'a call outside the recording',
      source: "async function run() { await host.callTool('eval', { code: 'return 3' }); await host.emit({ type: 'text_delta', text: 'x' }); }",
      failed: 'it called eval, which the recording does not hold',
    },
    { name: 'no answer', source: 'async function run() {}', failed: 'it gave no answer' },
    {
      name: 'a loop past its bound',
      source: "async function run() { for (let i = 0; i < 40; i++) await host.llmStream({ system: 's', messages: [{ role: 'user', content: 'again' }] }); await host.emit({ type: 'text_delta', text: 'x' }); }",
      failed: 'it passed its bound of',
    },
  ];

  for (const c of failing) {
    test(`a scaffold that gives ${c.name} fails on the first turn it fails, and says why`, async () => {
      const { rt, turns } = await recorded();
      const verdict = await replayScaffold(rt, c.source, turns);

      expect(verdict?.turnId).toBe(turns[0]?.turnId);
      expect(verdict?.failed).toContain(c.failed);
    });
  }

  test('with no recorded turn there is nothing to hold a version to, and it fails', async () => {
    const { rt } = await recorded();

    expect(await replayScaffold(rt, 'async function run() { await host.defaultInference(); }', [])).toEqual({
      turnId: null, failed: 'no answered turn is recorded to replay it against',
    });
  });

  test('nothing a replay does reaches the agent: its memory writes stay in the replay', async () => {
    const { rt, turns } = await recorded();
    const before = await rt.memory.read('memory/MEMORY.md');

    const source = `async function run() {
      await host.appendMemory('memory/MEMORY.md', 'written by a replay');
      await host.emit({ type: 'text_delta', text: await host.readMemory('memory/MEMORY.md') });
    }`;

    expect(await replayScaffold(rt, source, turns)).toBeNull();
    expect(await rt.memory.read('memory/MEMORY.md')).toBe(before);
  });
});

describe('a proposed scaffold is replayed off turn, and a pass becomes current at the next cold turn', () => {
  test('a version that passes stays pending until a cold turn, which then runs it', async () => {
    const { rt, session } = await recorded();
    const source = `async function* run(rt, task) { await host.defaultInference(); }`;

    expect(await modifyScaffold(rt, 'run the default turn through a loop of my own, so a later version can wrap its steps', source)).toMatchObject({ ok: true, version: 1 });
    await session.runRefinementLane();

    // Replayed, not yet current: a warm turn keeps the program it had.
    expect(scaffoldState(rt)).toMatchObject({
      versions: [{ version: 0, status: 'current' }, { version: 1, status: 'pending' }],
      decisions: [{ type: 'scaffold_replayed', version: 1, turns: 2 }],
    });

    try {
      setSystemTime(new Date(Date.now() + 3 * 60 * 60_000));
      await session.send('Say hello.', { id: crypto.randomUUID() });
    } finally {
      setSystemTime();
    }

    expect(scaffoldState(rt).versions).toEqual([{ version: 0, status: 'historical' }, { version: 1, status: 'current' }]);
    // The cold turn itself ran the version it promoted.
    expect(rt.storage.sql<{ program_version: number }>`SELECT program_version FROM actor_turn_claims ORDER BY claimed_at DESC LIMIT 1`[0]?.program_version).toBe(1);
  });

  test('a version that fails is rolled back at once, with the replay\'s reason on the rollback', async () => {
    const { rt, session, turns } = await recorded();

    expect(await modifyScaffold(rt, 'a loop of my own that will break on its first turn, which its replay must catch', "async function* run(rt, task) { throw new Error('the loop broke'); }")).toMatchObject({ ok: true });
    await session.runRefinementLane();

    const { versions, decisions } = scaffoldState(rt);
    expect(versions).toEqual([{ version: 0, status: 'current' }, { version: 1, status: 'rolled_back' }]);
    expect(decisions).toMatchObject([{ type: 'scaffold_rollback', fromVersion: 1, toVersion: 0 }]);
    expect(v.parse(v.object({ reason: v.string() }), decisions[0]).reason).toStartWith(`its replay failed on turn ${turns[0]?.turnId ?? ''}: it threw: `);
  });
});
