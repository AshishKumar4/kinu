import { expect, test } from 'bun:test';
import { failureRationale, type EvalRunOutput } from './task';

const metrics = { modelTurns: 3, toolCalls: 2, toolErrors: 0, providerWaits: 0, providerWaitMs: 0 };

/** A run of a turn that passed its check, then one that ended `outcome`, as the harness records it. */
function run(outcome: EvalRunOutput['turns'][number]['outcome'], checks: EvalRunOutput['turns'][number]['checks'] = []): EvalRunOutput {
  return { success: false, metrics, turns: [
    { outcome: { status: 'completed' }, checks: [{ id: 'board-built', pass: true }], turnWallMs: 60_000, verificationWallMs: 1_000 },
    { outcome, checks, turnWallMs: 450_000, verificationWallMs: 0 },
  ] };
}

// The reporter prints this for each failed trial, and the deploy's report shows it: a turn the deployment did not end
// is named with what held it, so a job left running is never read as the model failing.
test('a run that stopped on a turn that did not complete names the turn and why, and one that ran says which checks failed', () => {
  const hung = 'the workspace stayed busy for 421 s with no ledger row: held by running shell job bgjob-server (workspace: node server.js)';

  expect(failureRationale(run({ status: 'hung', message: hung, heldBy: ['running shell job'] })))
    .toBe(`failed: turn 2 hung (held by running shell job): ${hung}`);
  expect(failureRationale(run({ status: 'refused', message: 'could not read the chat history: 500' })))
    .toBe('failed: turn 2 refused: could not read the chat history: 500');
  expect(failureRationale(run({ status: 'completed' }, [{ id: 'board-reads-ledger', pass: false }]))).toBe('failed: board-reads-ledger');
});
