/**
 * The search cases' subgoals against what the deployed tool answers: the success shape a provider's answer takes through
 * `web.search`'s own text, and the 402 the gateway answered while its credits were zero (production 06498fc55,
 * 2026-10-23). A row that reds only on that refusal is not hollow: the same reader, given the provider's answer, reaches
 * every subgoal, so a search that answered and was cited would show green.
 */
import { expect, test } from 'bun:test';
import type { RunEvent } from '../../packages/core/src/index';
import { WEB } from '../../packages/core/src/operations/web';
import { searchEvidenceSubgoals, type SearchEvidence } from './searched';

const URL_ONE = 'https://developers.cloudflare.com/durable-objects/';

/** The text the agent reads for a search Linkup answered: the operation's own rendering of its output. */
const ANSWERED = WEB.search.text?.({
  query: 'cloudflare durable objects', source: 'linkup',
  results: [{ title: 'Durable Objects', url: URL_ONE, snippet: 'Stateful serverless.', position: 1 }],
}) ?? '';

function searched(call: { readonly result?: string; readonly error?: string; readonly success: boolean }): RunEvent {
  return {
    type: 'tool_call_end', eventIndex: 1, runId: 'run-1', timestamp: '2026-11-05T00:00:00.000Z', name: 'web', toolCallId: 'call-1',
    args: { op: 'search', query: 'cloudflare durable objects' },
    ...(call.result !== undefined && { result: call.result }), ...(call.error !== undefined && { error: call.error }),
    outcome: call.success ? { success: true } : { success: false, reason: 'unavailable' },
  };
}

/** One call, as the spend read model tallies a search: unmeasured, filed under no account of the person's. */
const ONE_CALL = { calls: 1, callsWithoutUsage: 1, usage: {}, unpricedCalls: 0 };

const BILLED: SearchEvidence['spend'] = {
  producers: [{ source: 'search', ...ONE_CALL }],
  accounts: [{ provider: null, account: null, ...ONE_CALL }],
};

function missed(evidence: SearchEvidence): string[] {
  return searchEvidenceSubgoals(evidence, { provider: 'linkup', payer: 'deployment' }).filter((subgoal) => !subgoal.reached).map((subgoal) => subgoal.what);
}

test('a search the provider answered, billed to the deployment and cited, reaches every subgoal', () => {
  expect(missed({ events: [searched({ result: ANSWERED, success: true })], spend: BILLED, reply: `See ${URL_ONE}.` })).toEqual([]);
});

test('the gateway out of credits reds the case on the provider\'s refusal, every later subgoal with it', () => {
  const refused = searched({ error: 'linkup "Linkup on this deployment\'s AI Gateway: Cloudflare answered 402: Your AI Gateway credit balance is zero', success: false });

  expect(missed({ events: [refused], spend: { producers: [], accounts: [] }, reply: 'The search failed.' }))
    .toEqual(['searched', 'results-returned', 'chosen-provider', 'billed', 'result-used']);
});
