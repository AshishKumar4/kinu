import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { failureRationale, taskVersion, type EvalRunOutput, type EvalTask } from './task';

const metrics = { modelTurns: 3, toolCalls: 2, toolErrors: 0, badInputCalls: 0, unknownToolCalls: 0, providerWaits: 0, providerWaitMs: 0 };

/** A run of a turn that passed its check, then one that ended `outcome`, as the harness records it. */
function run(outcome: EvalRunOutput['turns'][number]['outcome'], checks: EvalRunOutput['turns'][number]['checks'] = []): EvalRunOutput {
  return { success: false, metrics, turns: [
    { part: 'board', turn: 1, outcome: { status: 'completed' }, checks: [{ id: 'board-built', pass: true }], turnWallMs: 60_000, verificationWallMs: 1_000 },
    { part: 'board', turn: 2, outcome, checks, turnWallMs: 450_000, verificationWallMs: 0 },
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

test('a recorded check is never why a run failed', () => {
  expect(failureRationale(run({ status: 'completed' }, [{ id: 'tower-in-frame', pass: false, graded: false }, { id: 'tower-of-five', pass: false }])))
    .toBe('failed: tower-of-five');
});

test('a task\'s version counts the commands that prepared its executors, and a task with none keeps the version it had', () => {
  const task: EvalTask = { id: 'versioned', mission: 'A workspace.', parts: [{ id: 'one', objectives: ['Answer.'], turns: [{ prompt: 'Answer.' }] }] };
  const prepared = (command: string): EvalTask => ({ ...task, parts: [{ ...task.parts[0], turns: [{ prompt: 'Answer.', prepare: [{ executor: 'computer', command }] }] }] });

  // The hash this task had before turns could prepare an executor: a task without one is not re-versioned.
  expect(taskVersion(task)).toBe(createHash('sha256').update(JSON.stringify({ mission: 'A workspace.', turns: [{ seed: [], prompt: 'Answer.' }] })).digest('hex'));
  expect(new Set([taskVersion(task), taskVersion(prepared('true')), taskVersion(prepared('false'))]).size).toBe(3);
});
