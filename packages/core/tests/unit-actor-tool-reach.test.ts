import { expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import { createTestRuntime, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { hostedSeatsOver } from './helpers-actor-host';
import { profileCatalogDigest, resolveTurnProfile, type ProfileCatalog } from '../src/profiles';

test('a bound role governs provider tools, actual execution and the dynamic reader after revocation', async () => {
  const { rt, testSql } = createTestRuntime();
  const seats = hostedSeatsOver({ rt, db: testSql.db });
  const { actor } = await seats.seat('reach-prover', 'subordinate');
  let executions = 0;

  const tools = {
    eval: tool({ description: 'A gated effect', inputSchema: jsonSchema({ type: 'object' }), execute: async () => {
      executions++;

      return 'effect executed';
    } }),
    file: tool({ description: 'Read a file', inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'read' }),
  };

  try {
    for (const permitted of [true, false]) {
      const allowedTools = permitted ? ['eval', 'file'] : ['file'];

      const catalog = { roles: { reader: { description: 'Read what is allowed', instructions: 'Use current permissions.',
        tier: 'default', preset: 'ideate', allowedTools } }, tiers: { default: { model: 'test-model' } } } satisfies ProfileCatalog;

      const inputs = { envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
        provider: { revision: 'reach-test', availableModels: ['test-model'] } } satisfies Parameters<typeof actor.session.bindProfile>[2];

      const profile = resolveTurnProfile({ ...inputs, roleId: 'reader', workMode: 'build', availableTools: Object.keys(tools), activeSkills: [] });
      const lease = actor.session.beginTurn({ runId: `run-${permitted}`, turnId: `turn-${permitted}` }, 'build', 0);
      actor.session.bindProfile(lease, profile, inputs);
      actor.session.appendInput(lease, { role: 'user', content: 'Try the effect under current permissions.' });
      const seen: string[][] = [];
      let calls = 0;

      const model = scriptedTurnModel({ doGenerate: (): ScriptedTurnResult => {
        const invoke = calls++ === 0;

        return { content: invoke
          ? [{ type: 'tool-call', toolName: 'eval', toolCallId: `effect-${permitted}`, input: '{}' }]
          : [{ type: 'text', text: 'done' }],
        finishReason: { unified: invoke ? 'tool-calls' : 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
      } });

      try {
        await actor.session.execute(lease, {
          task: 'Try the effect under current permissions.', loopVersion: await actor.runtime.identity.scaffold.version(),
          chat: { model, system: 'Respect the current role.', tools }, extensions: [],
          dynamic: (_profile, available) => {
            seen.push(Object.keys(available));

            return { factsBlock: `Available: ${Object.keys(available).join(', ')}` };
          },
        }, () => {});
        expect(executions).toBe(1);
        expect(new Set(model.doStreamCalls[0]?.tools?.map((entry) => entry.name))).toEqual(new Set(allowedTools));
        expect(seen.length).toBeGreaterThan(0);

        for (const names of seen) expect(new Set(names)).toEqual(new Set(allowedTools));
      } finally {
        actor.session.finishTurn(lease);
      }
    }
  } finally {
    seats.host.releaseAll();
    testSql.close();
  }
});
