/**
 * The run ledger records what a tool RETURNED, never a rendering of it.
 *
 * A tool's output is a value — an object with an `action`, a list, a number —
 * and the readers that ask the ledger for it read fields off that value: the
 * first-run row for a sandbox write asks the `tool_call_end` row for
 * `{ action: 'created' }`. The loop renders the output to text for every
 * surface that renders; the ledger row is the value. Read back through the
 * turn accumulator's own record and the durable `tool_call_end` event the
 * turn's sinks receive.
 */
import { expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import { createTestRuntime, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { hostedSeatsOver } from './helpers-actor-host';
import { profileCatalogDigest, resolveTurnProfile, type ProfileCatalog } from '../src/profiles';

const WRITTEN = { ok: true, path: 'notes.txt', action: 'created' };

test('a successful tool call records the value it returned, and a text tool records its text', async () => {
  const { rt, testSql } = createTestRuntime();
  const seats = hostedSeatsOver({ rt, db: testSql.db });
  const { actor } = await seats.seat('record-prover', 'subordinate');

  const tools = {
    file: tool({ description: 'Write a file', inputSchema: jsonSchema({ type: 'object' }), execute: async () => WRITTEN }),
    run: tool({ description: 'Run a command', inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'hello\n' }),
  };

  const catalog = { roles: { writer: { description: 'Write', instructions: 'Write.',
    tier: 'default', preset: 'ideate', allowedTools: ['file', 'run'] } }, tiers: { default: { model: 'test-model' } } } satisfies ProfileCatalog;

  const inputs = { envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
    provider: { revision: 'record-test', availableModels: ['test-model'] } } satisfies Parameters<typeof actor.session.bindProfile>[2];

  const profile = resolveTurnProfile({ ...inputs, roleId: 'writer', workMode: 'build', availableTools: Object.keys(tools), activeSkills: [] });
  let calls = 0;

  const model = scriptedTurnModel({ doGenerate: (): ScriptedTurnResult => {
    const step = calls++;

    const content: ScriptedTurnResult['content'] = step === 0
      ? [{ type: 'tool-call', toolName: 'file', toolCallId: 'call-file', input: '{"action":"write"}' },
        { type: 'tool-call', toolName: 'run', toolCallId: 'call-run', input: '{"command":"echo hello"}' }]
      : [{ type: 'text', text: 'done' }];

    return { content, finishReason: { unified: step === 0 ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
  } });

  try {
    const lease = actor.session.beginTurn({ runId: 'run-record', turnId: 'turn-record' }, 'build', 0);
    actor.session.bindProfile(lease, profile, inputs);
    actor.session.appendInput(lease, { role: 'user', content: 'Write the notes.' });

    try {
      await actor.session.execute(lease, {
        task: 'Write the notes.', loopVersion: await actor.runtime.identity.scaffold.version(),
        chat: { model, system: 'Write.', tools }, extensions: [],
        dynamic: () => ({ factsBlock: '' }),
      }, () => {});

      const recorded = actor.session.orchestrator.acc.toolCalls.map((call) => [call.name, call.result]);
      // The object the tool returned, as a value; the string the tool returned, as a string.
      expect(recorded).toEqual([['file', WRITTEN], ['run', 'hello\n']]);
    } finally {
      actor.session.finishTurn(lease);
    }
  } finally {
    seats.host.releaseAll();
    testSql.close();
  }
});

test('a narrated multi-step turn answers with its final step, whatever it streamed', async () => {
  const { rt, testSql } = createTestRuntime();
  const seats = hostedSeatsOver({ rt, db: testSql.db });
  const { actor } = await seats.seat('answer-prover', 'subordinate');

  const tools = {
    run: tool({ description: 'Run a command', inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'ran' }),
  };

  const catalog = { roles: { runner: { description: 'Run', instructions: 'Run.',
    tier: 'default', preset: 'ideate', allowedTools: ['run'] } }, tiers: { default: { model: 'test-model' } } } satisfies ProfileCatalog;

  const inputs = { envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
    provider: { revision: 'answer-test', availableModels: ['test-model'] } } satisfies Parameters<typeof actor.session.bindProfile>[2];

  const profile = resolveTurnProfile({ ...inputs, roleId: 'runner', workMode: 'build', availableTools: Object.keys(tools), activeSkills: [] });
  let calls = 0;

  // Narration before each tool call, then the answer the prompt asked for:
  // "reply with only PASS or FAIL" is answered by the last step alone.
  const model = scriptedTurnModel({ doGenerate: (): ScriptedTurnResult => {
    const step = calls++;

    const content: ScriptedTurnResult['content'] = step < 2
      ? [{ type: 'text', text: step === 0 ? 'Copying the files into the sandbox:' : 'Running the test in the sandbox:' },
        { type: 'tool-call', toolName: 'run', toolCallId: `call-${String(step)}`, input: '{}' }]
      : [{ type: 'text', text: 'FAIL' }];

    return { content, finishReason: { unified: step < 2 ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
  } });

  try {
    const lease = actor.session.beginTurn({ runId: 'run-answer', turnId: 'turn-answer' }, 'build', 0);
    actor.session.bindProfile(lease, profile, inputs);
    actor.session.appendInput(lease, { role: 'user', content: 'Run the test and reply with only PASS or FAIL.' });

    try {
      const streamed: string[] = [];

      const result = await actor.session.execute(lease, {
        task: 'Run the test and reply with only PASS or FAIL.', loopVersion: await actor.runtime.identity.scaffold.version(),
        chat: { model, system: 'Answer.', tools }, extensions: [],
        dynamic: () => ({ factsBlock: '' }),
      }, (event) => { if (event.type === 'text-delta') streamed.push(event.delta); });

      // The narration reached whoever was watching, one step at a time; the
      // answer the turn is recorded under is the final step's alone.
      expect(streamed).toEqual(['Copying the files into the sandbox:', 'Running the test in the sandbox:', 'FAIL']);
      expect(result.text).toBe('FAIL');
      expect(result.failure).toBeNull();
    } finally {
      actor.session.finishTurn(lease);
    }
  } finally {
    seats.host.releaseAll();
    testSql.close();
  }
});
