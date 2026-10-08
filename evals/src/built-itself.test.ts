import { expect, test } from 'bun:test';
import type { RunEvent } from '@kinu.run/core';
import { builtItself } from '../tasks/slate-quality';
import { EvalVerifier, type VerifierSession } from './verifier';

// A hire is the same admitted delegation however the lead calls it: the native `agents` tool, or `agents.hire` inside
// a program, which reaches the model's record only as an `eval` call. The check reads the lead's helpers and swarms.
const TURN = 100;

function ended(name: string, args: Record<string, string>): RunEvent {
  return { type: 'tool_call_end', runId: 'lead', eventIndex: 1, timestamp: new Date(TURN + 5).toISOString(), name, toolCallId: name, args, outcome: { success: true } };
}

/** A lead that hired `helper` this turn, or no one: what the inspector lists and its run started after the prompt. */
function lead(calls: readonly RunEvent[], helper: string | null): VerifierSession {
  const refused = () => Promise.reject(new Error('not read by this check'));

  return {
    web: { origin: 'http://127.0.0.1:8787', identity: { kind: 'loopback' }, workspace: 'eval-built-itself' },
    slateOp: refused, listSlates: refused, readFile: refused, readBytes: refused, writeFile: refused, listFiles: refused,
    craftedTools: refused, memoryContent: refused, memoryFacts: refused, workspaceWork: refused, execute: refused, exposedPorts: refused,
    runEvents: () => Promise.resolve([...calls]),
    swarmRuns: () => Promise.resolve([]),
    inspect: (request) => {
      if (request.view === 'children') {
        const items = helper === null ? [] : [{ name: helper, status: 'working', lifetime: 'task', actorReference: { actorId: `actor-${helper}` } }];

        return Promise.resolve({ view: 'children', page: { status: 'end', items } });
      }

      return Promise.resolve({ view: 'runs', page: { status: 'end', items: [{ runId: 'brief', startedAt: TURN + 10, status: 'running', userMessage: 'Build the board' }] } });
    },
  };
}

async function hiredNoOne(session: VerifierSession): Promise<boolean | undefined> {
  const checks = await new EvalVerifier(session, [], TURN, () => Promise.resolve()).collect((verifier) => builtItself(verifier, ['chess']));

  return checks.find((check) => check.id === 'hired-no-one')?.pass;
}

test('a helper hired natively or from a program fails hired-no-one, and a turn that hired no one passes', async () => {
  const native = lead([ended('agents', { op: 'hire', name: 'board-builder', brief: 'Build the board' })], 'board-builder');
  const program = lead([ended('eval', { code: 'await agents.hire({ name: "board-builder", brief: "Build the board" });' })], 'board-builder');
  const alone = lead([ended('eval', { code: 'return await workspace.slates.chess.$preview();' })], null);

  expect(await Promise.all([hiredNoOne(native), hiredNoOne(program), hiredNoOne(alone)])).toEqual([false, false, true]);
});
