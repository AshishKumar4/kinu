/**
 * Recovery must leave a live turn's claim alone while that turn settles. A delegated turn's claim settles only after
 * its advisor review, when the session no longer reads as in flight; a sweep in that window settled the live claim
 * `indeterminate` and the hirer never got its report (review job 139 on 9359ce96e1).
 */
import { expect, test } from 'bun:test';
import { createTestRuntime, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { hostedSeatsOver } from './helpers-actor-host';
import { recoverActorTurns } from '../src/state/actor-host';
import { profileCatalogDigest, resolveTurnProfile, type ProfileCatalog } from '../src/profiles';

function answer(): ScriptedTurnResult {
  return { content: [{ type: 'text', text: 'done' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
}

test('a sweep between a turn\'s answer and its claim settle leaves the claim to that turn', async () => {
  const { rt, testSql } = createTestRuntime();
  const seats = hostedSeatsOver({ rt, db: testSql.db });
  const { actor } = await seats.seat('settling-child', 'subordinate');

  const catalog = { roles: { reader: { description: 'Read', instructions: 'Read.',
    tier: 'default', preset: 'ideate', allowedTools: [] } }, tiers: { default: { model: 'test-model' } } } satisfies ProfileCatalog;

  const inputs = { envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
    provider: { revision: 'settling-test', availableModels: ['test-model'] } } satisfies Parameters<typeof actor.session.bindProfile>[2];

  const profile = resolveTurnProfile({ ...inputs, roleId: 'reader', workMode: 'build', availableTools: [], activeSkills: [] });

  try {
    const lease = actor.session.beginTurn({ runId: 'run-settling', turnId: 'turn-settling' }, 'build', 0);
    actor.session.bindProfile(lease, profile, inputs);
    await actor.session.openTurnInput(lease, { item: {}, message: { role: 'user', content: 'Read the file.' }, birthContext: async () => [] });

    await actor.session.execute(lease, {
      task: 'Read the file.', loopVersion: await actor.runtime.identity.scaffold.version(),
      chat: { model: scriptedTurnModel({ doGenerate: answer }), system: 'Answer.', tools: {} }, extensions: [],
      dynamic: () => ({ factsBlock: '' }),
    }, () => {});

    // The answer is in; the advisor review and the claim settle are still ahead of this turn.
    const swept = await recoverActorTurns(seats.host);

    expect(swept.active).toEqual(['turn-settling']);
    expect(actor.stores.claims.read('turn-settling')?.status).toBe('admitted');

    actor.session.settleTurnClaim(lease, 'completed');
    actor.session.finishTurn(lease);
    expect(actor.stores.claims.read('turn-settling')).toMatchObject({ status: 'settled', outcome: 'completed' });
  } finally {
    seats.host.releaseAll();
    testSql.close();
  }
});
