/**
 * A hire's advisor: the main actor hires through its `agents` tool, the hire takes its assignment as it is admitted, its
 * steps are reviewed in its own isolate, and the advice lands where its severity sends it; every model call is the
 * platform gateway's.
 */
import type { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { ADVISOR_HEADER } from '@kinu.run/core';
import { agentSql, catalogTurn, driveUntil, gatewayWorkspace, relayedReports, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';
import { joinHarnessFibers } from './helpers/agents-sdk';

const MISSION = 'Catalogue every file under the home directory.';

/** The hire's requests open with its assignment; the main actor's open with the owner's message. */
function forTheHire(run: RecordedGatewayRun): boolean {
  return openingOf(run).includes(MISSION);
}

/** The main actor's model: hire `agent` for the mission, then say so. */
function hiring(run: RecordedGatewayRun, agent: string | undefined, lifetime?: 'task'): Response {
  const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

  return step === 0
    ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', message: MISSION, ...(agent !== undefined && { name: agent }), ...(lifetime && { lifetime }) } }, 'hire_0')
    : chatCompletion(run, 'Handed off.');
}

/** The advisor's own call: it alone is offered the `advise` tool. */
function forTheAdvisor(run: RecordedGatewayRun): boolean {
  return requestOf(run).tools.includes('advise');
}

/** The advisor's answer: `advice` as its one `advise` call, or silence. */
function advising(run: RecordedGatewayRun, advice: { readonly note: string; readonly severity: 'concern' | 'blocker' } | null): Response {
  return advice === null ? chatCompletion(run, '') : toolCallCompletion(run, { tool: 'advise', args: { ...advice, class: 'wrong-work' } }, 'advise_0');
}

/** The hire named `advised`, whose rows are in its own database. */
function advisedHire(db: Database): string {
  return db.query<{ actor_id: string }, []>("SELECT actor_id FROM workspace_actors WHERE name = 'advised'").get()?.actor_id ?? '';
}

test("a hosted subagent's steps are reviewed in its own isolate, and its blocker opens its next turn, adding to no evolution window", async () => {
  const note = 'The probe failed but the reply claimed success. Read the exit status.';
  const requests: string[] = [];
  const reviews: string[] = [];

  const gateway = stubAiBinding((run) => {
    const request = JSON.stringify(requestOf(run).messages);

    if (forTheAdvisor(run)) {
      reviews.push(request);

      return advising(run, { note, severity: 'blocker' });
    }

    if (!forTheHire(run)) return hiring(run, 'advised');
    requests.push(request);

    return chatCompletion(run, 'The probe succeeded.');
  });

  const workspace = gatewayWorkspace(gateway);
  const root = workspaceMainActor(workspace.db);

  // On before the hire is: its turn runs as soon as its assignment is admitted.
  root.config.setAdvisorEnabled(true);
  await catalogTurn(workspace.agent, 'Have someone check the probe.');
  // The root's own window grows with the turns the relays open; no hosted actor's ever does.
  const hostedTurns = () => workspace.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM completed_turns WHERE actor_id != ?').get(root.actorId)?.n ?? 0;

  // The hire's notes and window are in its own database.
  const hire = () => advisedHire(workspace.db);
  const advisorNotes = () => agentSql(workspace, hire())<{ actor_id: string; message: string }>`SELECT actor_id, message FROM evolution_events WHERE type = 'advisor_note'`;
  const ownTurns = () => agentSql(workspace, hire())<{ n: number }>`SELECT COUNT(*) AS n FROM completed_turns`[0]?.n ?? 0;

  // The hire's turn ends on its own answer, its review waited for; the blocker opens the hire's next turn.
  await driveUntil(workspace, 'the advice reached the hire', () => requests.length >= 2);
  await joinHarnessFibers();

  expect(relayedReports(workspace.db)[0]).toBe('The probe succeeded.');
  expect(requests[0]).not.toContain(ADVISOR_HEADER);
  expect(requests[1]).toContain(ADVISOR_HEADER);
  expect(reviews.length).toBeGreaterThanOrEqual(1);
  const notes = advisorNotes().filter((row) => row.actor_id !== root.actorId);
  expect(notes.map((row) => row.message)).toEqual([note]);
  expect(hostedTurns()).toBe(0);
  expect(ownTurns()).toBe(0);
});

function advisedWorkspace(severity: 'concern' | 'blocker') {
  const note = 'Stop relying on the failed run.';
  const hireRequests: string[] = [];

  const gateway = stubAiBinding((run) => {
    const request = JSON.stringify(requestOf(run).messages);

    if (forTheAdvisor(run)) return advising(run, { note, severity });

    if (!forTheHire(run)) return hiring(run, 'advised');
    hireRequests.push(request);

    return chatCompletion(run, 'The probe succeeded.');
  });

  const workspace = gatewayWorkspace(gateway);
  const root = workspaceMainActor(workspace.db);
  const hire = () => advisedHire(workspace.db);
  const judged = () => agentSql(workspace, hire())<{ data: string }>`SELECT data FROM evolution_events WHERE type = 'advisor_note'`.map((row) => row.data);

  return { gateway, workspace, root, hireRequests, judged };
}

test("a hire's advice is judged against the owner's severity floor", async () => {
  const { workspace, root, hireRequests, judged } = advisedWorkspace('concern');

  root.config.setAdvisorEnabled(true);
  root.config.setAdvisorMinSeverity('blocker');
  await catalogTurn(workspace.agent, 'Have someone check the probe.');
  await driveUntil(workspace, "the hire's advice was never judged", () => judged().length > 0);
  await joinHarnessFibers();

  expect(judged().join(' ')).toContain('"spoken":false');
  expect(hireRequests).toHaveLength(1);
});

test("a hire's blocker advice reaches its hirer, not the hire again", async () => {
  const { gateway, workspace, root } = advisedWorkspace('blocker');
  const ask = 'Have someone check the probe.';
  const requests = () => gateway.runs.map((run) => JSON.stringify(requestOf(run).messages));
  // The hirer's conversation holds its own ask; a hire's never does.
  const toHirer = () => requests().filter((request) => request.includes('[Actor advised]') && request.includes(ask));

  // The hire's conversation never holds the root's ask; its advisor's reads its steps.
  const hireToldAgain = () => gateway.runs.filter((run) => !forTheAdvisor(run)).map((run) => JSON.stringify(requestOf(run).messages))
    .filter((request) => request.includes('[Actor advised]') && !request.includes(ask));

  root.config.setAdvisorEnabled(true);
  await catalogTurn(workspace.agent, ask);
  await driveUntil(workspace, "the blocker never reached the hirer's turns", () => toHirer().length > 0);
  await joinHarnessFibers();

  expect(hireToldAgain()).toEqual([]);
});

// Review P1 (d35c1060fe): an advisor with nothing to say opens no later turn, so its hire's answer must not wait on one.
test('a task hire whose advisor has nothing to say still answers its hirer', async () => {
  const gateway = stubAiBinding((run) => {
    if (forTheAdvisor(run)) return advising(run, null);

    if (!forTheHire(run)) return hiring(run, undefined, 'task');

    return chatCompletion(run, 'The probe succeeded.');
  });

  const workspace = gatewayWorkspace(gateway);

  workspaceMainActor(workspace.db).config.setAdvisorEnabled(true);
  await catalogTurn(workspace.agent, 'Have someone check the probe.');

  await driveUntil(workspace, 'the task hire answered its hirer', () => relayedReports(workspace.db).length > 0);
  expect(relayedReports(workspace.db)).toEqual(['The probe succeeded.']);
});
