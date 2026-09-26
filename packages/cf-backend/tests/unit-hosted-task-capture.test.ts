/**
 * Defends: a delegated turn's report coming back empty because the runner and
 * the tool surface recorded into two different `HeadCapture`s.
 * The main actor hires through its `agents` tool, the wake runs the hire's assignment, and the hire's
 * report lands in the main actor's inbox; every model call is the platform gateway's.
 */
import { expect, test } from 'bun:test';
import { ADVISOR_HEADER } from '@kinu.run/core';
import { catalogTurn, gatewayWorkspace, relayedReports, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';
import { joinHarnessFibers } from './helpers/agents-sdk';

const MISSION = 'Catalogue every file under the home directory.';

/** The hire's requests open with its assignment; the main actor's open with the owner's message. */
function forTheHire(run: RecordedGatewayRun): boolean {
  return openingOf(run).includes(MISSION);
}

/** The main actor's model: hire `agent` for the mission, then say so. */
function hiring(run: RecordedGatewayRun, agent: string): Response {
  const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

  return step === 0
    ? toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', agent, mission: MISSION } }, 'hire_0')
    : chatCompletion(run, 'Handed off.');
}

test("a delegated turn's tool call reaches the answer its caller gets", async () => {
  const gateway = stubAiBinding((run) => {
    if (!forTheHire(run)) return hiring(run, 'reader');
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

    // One call, then whitespace with no prose: the loop reads a step's text as final only when non-blank,
    // so the answer is synthesised from the capture.
    return step === 0
      ? toolCallCompletion(run, { tool: 'file', args: { action: 'list', path: '/home/main' } }, 'file_0')
      : chatCompletion(run, '  ');
  });

  const workspace = gatewayWorkspace(gateway);

  await catalogTurn(workspace.agent, 'Have a reader catalogue the home directory.');
  await workspace.agent.terminalRetryPass();
  await joinHarnessFibers();

  // No decision or finding, so the synthesis falls to the tool tally from the shared capture.
  expect(relayedReports(workspace.db)).toEqual(['Ran 1 tool call(s): file']);
});

test('a hosted subordinate is advised without adding a turn to either evolution window', async () => {
  const note = 'The probe failed but the reply claimed success. Read the exit status.';
  const requests: string[] = [];
  const reviews: string[] = [];

  const gateway = stubAiBinding((run) => {
    const request = JSON.stringify(requestOf(run).messages);

    if (request.includes('You are reviewing one finished turn')) {
      reviews.push(request);

      return chatCompletion(run, JSON.stringify({ note, severity: 'concern', class: 'wrong-work' }));
    }

    if (!forTheHire(run)) return hiring(run, 'advised');
    requests.push(request);

    return chatCompletion(run, 'The probe succeeded.');
  });

  const workspace = gatewayWorkspace(gateway);
  const root = workspaceMainActor(workspace.db);

  await catalogTurn(workspace.agent, 'Have someone check the probe.');
  root.config.setAdvisorEnabled(true);
  const completedTurns = () => workspace.db.query('SELECT actor_id, turn FROM completed_turns').all();

  const advisorNotes = () => workspace.db.query<{ actor_id: string; message: string }, []>(
    "SELECT actor_id, message FROM evolution_events WHERE type = 'advisor_note'",
  ).all();

  const before = completedTurns();

  await workspace.agent.terminalRetryPass();
  await joinHarnessFibers();

  expect(relayedReports(workspace.db)).toEqual(['The probe succeeded.']);
  expect(reviews).toHaveLength(2);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain(ADVISOR_HEADER);
  const notes = advisorNotes();
  expect(notes.map((row) => row.message)).toEqual([note]);
  expect(notes.map((row) => row.actor_id)).not.toContain(root.actorId);
  expect(completedTurns()).toEqual(before);
});
