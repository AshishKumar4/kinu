/**
 * The claim's context is the request the turn sent, including the turn-local tail spliced in at
 * assembly, or a shadow trial would score a narrower prompt than the live turn ran.
 */
import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { createTestRuntime, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { hostedSeatsOver } from './helpers-actor-host';
import { profileCatalogDigest, resolveTurnProfile, type ProfileCatalog } from '../src/profiles';

const TURN_LOCAL: ModelMessage = { role: 'user', content: '[turn-local] AGENTS.md is unverified this turn.' };

function answer(): ScriptedTurnResult {
  return { content: [{ type: 'text', text: 'done' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
}

/** The text a message carries, as the transcript readers spell it. */
function textOf(message: ModelMessage): string {
  if (v.is(v.string(), message.content)) return message.content;

  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
}

for (const withTail of [true, false]) {
  test(`the claim names ${withTail ? 'the history and the turn-local tail' : 'the history alone when there is no tail'}`, async () => {
    const { rt, testSql } = createTestRuntime();
    const seats = hostedSeatsOver({ rt, db: testSql.db });
    const { actor } = await seats.seat('claim-prover', 'subordinate');

    const catalog = { roles: { reader: { description: 'Read', instructions: 'Read.',
      tier: 'default', preset: 'ideate', allowedTools: [] } }, tiers: { default: { model: 'test-model' } } } satisfies ProfileCatalog;

    const inputs = { envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
      provider: { revision: 'claim-test', availableModels: ['test-model'] } } satisfies Parameters<typeof actor.session.bindProfile>[2];

    const profile = resolveTurnProfile({ ...inputs, roleId: 'reader', workMode: 'build', availableTools: [], activeSkills: [] });
    const model = scriptedTurnModel({ doGenerate: answer });

    try {
      const lease = actor.session.beginTurn({ runId: 'run-claim', turnId: 'turn-claim' }, 'build', 0);
      actor.session.bindProfile(lease, profile, inputs);
      await actor.session.openTurnInput(lease, { item: {}, message: { role: 'user', content: 'What does the file say?' }, birthContext: async () => [] });

      try {
        const result = await actor.session.execute(lease, {
          task: 'What does the file say?', loopVersion: await actor.runtime.identity.scaffold.version(),
          chat: { model, system: 'Answer.', tools: {}, ...(withTail && { turnLocal: [TURN_LOCAL] }) }, extensions: [],
          dynamic: () => ({ factsBlock: '' }),
        }, () => {});

        const admitted = result.admittedMessages.map(textOf);
        const sent = (model.doStreamCalls[0]?.prompt ?? []).flatMap((m) => m.role === 'system' ? [] : [textOf(m)]);
        const history = actor.session.history.map(textOf);

        // The claim is the first request, tail included when there is one.
        expect(admitted).toEqual(withTail ? ['What does the file say?', textOf(TURN_LOCAL)] : ['What does the file say?']);
        expect(sent).toEqual(admitted);
        // The tail belongs to the request, never the working history.
        expect(history).toEqual(['What does the file say?', 'done']);
      } finally {
        actor.session.finishTurn(lease);
      }
    } finally {
      seats.host.releaseAll();
      testSql.close();
    }
  });
}
