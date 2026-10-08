/**
 * Every hire returns at once (owner, SUBAGENTS.md §4): the hirer's turn ends, and the child's answer or failure
 * arrives later as a message that opens the hirer's next turn, through the durable report path. A Stop reaches the
 * agents a stopped agent hired.
 */
import { expect, test } from 'bun:test';
import { sqlOver } from '@kinu.run/test-utils';
import { EventLog, SubordinateRosterStore, actorConnectionTag, admitSubordinateTask } from '@kinu.run/core';
import { createRecordingLogger, KinuError, setDiagnosticsSink } from '@kinu.run/core/obs';
import { makeSqlExec } from '../../core/tests/helpers';
import { asPane, joinHarnessFibers, joinHarnessKeepAlives } from './helpers/agents-sdk';
import {
  actorOver, agentSql, catalogTurn, driveUntil, gatewayWorkspace, hostedSubordinateHarness, runDelegatedTask, wakeForDelegatedTask,
} from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

/** A model call's own user turns, without the runtime's context blocks (which list other agents' briefs). */
const openingOf = (run: RecordedGatewayRun): string => JSON.stringify(requestOf(run).messages.filter((message) =>
  message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context')));

const toolResults = (run: RecordedGatewayRun): number => requestOf(run).messages.filter((message) => message.role === 'tool').length;

/** A model call that answers only when its turn is aborted, the way a stopped provider call ends. */
function heldUntilAborted(run: RecordedGatewayRun): Promise<Response> {
  const { promise, reject } = Promise.withResolvers<Response>();
  run.signal?.addEventListener('abort', () => { reject(run.signal?.reason); }, { once: true });

  return promise;
}

/** The middle hires one task agent, 'Leaf task.', whose call answers once `answered` settles; then relays it. */
function leafHire(answered: Promise<void>, asked: () => void) {
  return async (run: RecordedGatewayRun): Promise<Response> => {
    const opening = openingOf(run);

    if (opening.includes('Leaf task.')) {
      asked();
      await answered;

      return chatCompletion(run, 'Leaf done.');
    }

    if (opening.includes('Leaf done.')) return chatCompletion(run, 'Middle relays Leaf done.');

    return toolResults(run) === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', mission: 'Leaf task.' } }, 'call_leaf')
      : chatCompletion(run, 'Middle waits.');
  };
}

async function helperWorkspace(respond: (run: RecordedGatewayRun) => Response | Promise<Response>) {
  const gateway = stubAiBinding(respond);
  const workspace = gatewayWorkspace(gateway);
  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');

  const middle = await hostedSubordinateHarness(workspace, {
    name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate',
  });

  const sql = sqlOver(workspace.db);

  // A hire's runs are in its own database.
  const count = (actorId: string, type: 'run_start' | 'run_end'): number => agentSql(actorId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${actorId} AND type = ${type}`[0]?.n ?? 0;

  const hired = (): string | undefined => sql<{ id: string }>`
    SELECT actor_id AS id FROM workspace_actors WHERE parent_actor_id = ${middle.actor.handle.actorId}`[0]?.id;

  const retiring = (actorId: string): boolean => sql<{ at: number | null }>`
    SELECT retiring_at AS at FROM workspace_actors WHERE actor_id = ${actorId}`[0]?.at != null;

  return { gateway, workspace, middleId: middle.actor.handle.actorId, count, hired, retiring };
}

test("a helper's task hire returns at once, and the answer opens the helper's next turn", async () => {
  const release = Promise.withResolvers<void>();
  let leafAsked = false;

  const { gateway, workspace, middleId, count, hired, retiring } = await helperWorkspace(leafHire(release.promise, () => { leafAsked = true; }));

  await wakeForDelegatedTask(workspace, middleId, 'Middle task.');
  await driveUntil(workspace, 'the helper\'s turn never ended while its task hire worked', () => leafAsked && count(middleId, 'run_end') > 0);
  // The hire returned while its agent was still working: the helper's turn ended holding no wait.
  expect(gateway.unanswered.size).toBe(1);

  release.resolve();
  await driveUntil(workspace, 'the task agent\'s answer never opened the helper\'s next turn', () => count(middleId, 'run_start') >= 2);
  await driveUntil(workspace, 'the helper never answered on its task agent\'s message', () => count(middleId, 'run_end') >= 2);
  expect(gateway.runs.some((run) => openingOf(run).includes('Leaf done.'))).toBe(true);
  // The task agent retires once its answer is held, keeping its history.
  const leaf = hired() ?? '';
  await driveUntil(workspace, 'the answered task agent never retired', () => retiring(leaf));
});

test("a helper whose turn ends with its hire still working is released, and no drain runs on the released session", async () => {
  const release = Promise.withResolvers<void>();
  let leafAsked = false;

  const { workspace, middleId, count } = await helperWorkspace(leafHire(release.promise, () => { leafAsked = true; }));

  const recording = createRecordingLogger();
  const restore = setDiagnosticsSink(recording);

  try {
    await wakeForDelegatedTask(workspace, middleId, 'Middle task.');
    await driveUntil(workspace, 'the helper\'s turn never ended while its task hire worked', () => leafAsked && count(middleId, 'run_end') > 0);
    // A drain armed on the released session fires once its debounce ends, and fails against the release.
    await joinHarnessKeepAlives(workspace.agent);
    expect(recording.emitted.filter((line) => line.event === 'orchestrator.drain_select_failed')).toEqual([]);

    release.resolve();
    await driveUntil(workspace, 'the task agent\'s answer never opened the helper\'s next turn', () => count(middleId, 'run_end') >= 2);
  } finally {
    restore();
  }
});

test('a hire whose facet cannot load reports its named failure to its hirer', async () => {
  const gateway = stubAiBinding((run) => openingOf(run).includes('[subordinate_report]') || toolResults(run) > 0
    ? chatCompletion(run, 'Root received the failure.')
    : toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', mission: 'Unloadable task.' } }, 'call_unloadable'));

  const workspace = gatewayWorkspace(gateway);

  Object.defineProperty(workspace.agent, 'agentCalls', { value: async () => {
    throw new KinuError('unsupported', 'loader refused the facet compatibility flag');
  } });
  await catalogTurn(workspace.agent, 'Hire one task agent.');
  const reports = () => gateway.runs.map(openingOf).filter((text) => text.includes('[subordinate_report]'));

  await driveUntil(workspace, 'the load failure never reached the hirer', () => reports().length > 0);
  const hire = workspace.db.query<{ name: string }, []>("SELECT name FROM workspace_actors WHERE origin = 'agent'").get();

  expect(reports().join(' ')).toContain(hire?.name ?? 'missing hire');
  expect(reports().join(' ')).toContain('loader refused the facet compatibility flag');
  expect(reports().join(' ')).toContain('failed');
});

test("a durable hire whose turn fails delivers its failure to its hirer as a message", async () => {
  const { gateway, workspace, middleId, count } = await helperWorkspace((run) => {
    const opening = openingOf(run);

    if (opening.includes('Durable task.')) return new Response('', { status: 400 });

    if (toolResults(run) === 0 && opening.includes('Middle task.') && !opening.includes('failed')) {
      return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable');
    }

    return chatCompletion(run, 'Middle noted.');
  });

  await wakeForDelegatedTask(workspace, middleId, 'Middle task.');
  await driveUntil(workspace, 'the failed hire\'s failure never opened its hirer\'s next turn', () => count(middleId, 'run_start') >= 2);
  await driveUntil(workspace, 'the helper never answered on its hire\'s failure', () => count(middleId, 'run_end') >= 2);

  const told = gateway.runs.filter((run) => openingOf(run).includes('This turn failed before an answer existed'));

  expect(told.length).toBe(1);
  expect(new SubordinateRosterStore(makeSqlExec(workspace.db), actorOver(workspace.db, middleId)).list())
    .toMatchObject([{ status: 'awaiting_input', currentTask: 'Durable task.' }]);
});

test("a Stop reaches the agent a stopped helper hired, and wakes no one", async () => {
  let durableAsked = false;

  const { workspace, middleId, count, hired } = await helperWorkspace((run) => {
    const opening = openingOf(run);

    if (opening.includes('Durable task.')) {
      durableAsked = true;

      return heldUntilAborted(run);
    }

    return toolResults(run) === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable')
      : chatCompletion(run, 'Middle waits.');
  });

  await wakeForDelegatedTask(workspace, middleId, 'Middle task.');
  await driveUntil(workspace, 'the durable hire never started its turn', () => durableAsked);
  const durableId = hired() ?? '';

  await workspace.agent.cancelCurrentWork();
  await driveUntil(workspace, 'the Stop never ended the hired agent\'s turn', () => count(durableId, 'run_end') > 0);

  await joinHarnessFibers();
  expect(new SubordinateRosterStore(makeSqlExec(workspace.db), actorOver(workspace.db, middleId)).list())
    .toMatchObject([{ status: 'awaiting_input', currentTask: 'Durable task.' }]);
  expect(count(middleId, 'run_start')).toBe(1);
});

// hire.test flaked on this (staging-flows-scripted-569bb6869d run 1; flake-gate 3 of 6): a task helper's progress note
// and its hire's answer queued as two turns, and the helper settled on the first, with the answer still queued.
test("a task agent does not settle while more input is queued for it: its answer is its last turn's", async () => {
  const parked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const gateway = stubAiBinding(async (run) => {
    const opening = openingOf(run);

    if (opening.includes('Queued note.')) return chatCompletion(run, 'second answer');

    if (opening.includes('Helper brief.')) {
      parked.resolve();
      await release.promise;

      return chatCompletion(run, 'first answer');
    }

    if (opening.includes('answer')) return chatCompletion(run, 'Root noted.');

    return toolResults(run) === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', mission: 'Helper brief.' } }, 'call_helper')
      : chatCompletion(run, 'Root waits.');
  });

  const workspace = gatewayWorkspace(gateway);
  const sql = sqlOver(workspace.db);
  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');

  const turn = catalogTurn(workspace.agent, 'Hire a helper.');

  await driveUntil(workspace, 'the task helper never started', () => gateway.runs.some((run) => openingOf(run).includes('Helper brief.')));
  await turn;
  const helperId = sql<{ id: string }>`SELECT actor_id AS id FROM workspace_actors WHERE origin IN ('user','agent','evolution')`[0]?.id ?? '';
  // More input queues for the helper while its first turn is still out.
  await wakeForDelegatedTask(workspace, helperId, 'Queued note.');
  release.resolve();

  const rootTold = (): string[] => gateway.runs.map(openingOf).filter((opening) => opening.includes('[subordinate_report]'));

  await driveUntil(workspace, 'the task helper\'s answer never reached the root', () => rootTold().length > 0);

  expect(rootTold().join(' ')).toContain('second answer');
  expect(rootTold().join(' ')).not.toContain('first answer');
});

test("an agent the owner added keeps its own Stop: a root Stop skips it, and its own Stop reaches its hires", async () => {
  let durableAsked = false;
  let held: AbortSignal | undefined;

  const gateway = stubAiBinding((run) => {
    const opening = openingOf(run);

    if (opening.includes('Durable task.')) {
      durableAsked = true;
      held = run.signal;

      return heldUntilAborted(run);
    }

    return toolResults(run) === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable')
      : chatCompletion(run, 'Added agent waits.');
  });

  const workspace = gatewayWorkspace(gateway);
  const sql = sqlOver(workspace.db);
  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const added = subordinate.actorId ?? '';

  // A hire's runs are in its own database.
  const ended = (actorId: string): number => agentSql(actorId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${actorId} AND type = 'run_end'`[0]?.n ?? 0;

  await wakeForDelegatedTask(workspace, added, 'Added task.');
  await driveUntil(workspace, 'the added agent\'s hire never started its turn', () => durableAsked);
  const hired = sql<{ id: string }>`SELECT actor_id AS id FROM workspace_actors WHERE parent_actor_id = ${added}`[0]?.id ?? '';

  // A root Stop interrupts every agent it reaches before it returns; the added agent's hire is not one.
  await workspace.agent.cancelCurrentWork();
  expect(held?.aborted).toBe(false);

  await asPane([actorConnectionTag(added)], () => workspace.agent.cancelCurrentWork());
  await driveUntil(workspace, 'the added agent\'s Stop never reached its hire', () => ended(hired) > 0);
});

// Review P1 (integration/0963): archiving a middle agent kept its durable hires running under a retired hirer.
test("archiving an agent the owner added retires the durable agent it hired", async () => {
  let held: AbortSignal | undefined;

  const gateway = stubAiBinding((run) => {
    const opening = openingOf(run);

    if (opening.includes('Durable task.')) {
      held = run.signal;

      return heldUntilAborted(run);
    }

    return toolResults(run) === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable')
      : chatCompletion(run, 'Added agent waits.');
  });

  const workspace = gatewayWorkspace(gateway);
  const sql = sqlOver(workspace.db);
  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const added = subordinate.actorId ?? '';

  await wakeForDelegatedTask(workspace, added, 'Added task.');
  await driveUntil(workspace, 'the added agent\'s hire never started its turn', () => held !== undefined);
  const hired = sql<{ id: string }>`SELECT actor_id AS id FROM workspace_actors WHERE parent_actor_id = ${added}`[0]?.id ?? '';

  await workspace.agent.dismissSubordinate(subordinate.name, true);

  expect(held?.aborted).toBe(true);
  expect(sql<{ at: number | null }>`SELECT retiring_at AS at FROM workspace_actors WHERE actor_id = ${hired}`[0]?.at).not.toBeNull();
});

// Review P1 (integration/0963): a Stop interrupted a running descendant but left input already queued for it, which
// then ran as a fresh turn after the Stop.
test("a Stop discards the input already queued for a descendant it interrupts", async () => {
  let durableAsked = false;
  let queuedAsked = false;

  const { workspace, middleId, hired } = await helperWorkspace((run) => {
    const opening = openingOf(run);

    if (opening.includes('Queued input.')) {
      queuedAsked = true;

      return chatCompletion(run, 'Ran after the Stop.');
    }

    if (opening.includes('Durable task.')) {
      durableAsked = true;

      return heldUntilAborted(run);
    }

    return toolResults(run) === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable')
      : chatCompletion(run, 'Middle waits.');
  });

  await wakeForDelegatedTask(workspace, middleId, 'Middle task.');
  await driveUntil(workspace, 'the durable hire never started its turn', () => durableAsked);
  await wakeForDelegatedTask(workspace, hired() ?? '', 'Queued input.');

  await workspace.agent.cancelCurrentWork();

  await expect(driveUntil(workspace, 'the queued input never ran', () => queuedAsked)).rejects.toThrow('the queued input never ran');
});

// Owner, 2026-09-26: no limit on helper turns. Two hired agents' admitted turns run at once, neither queued behind the other.
test("two hired agents' admitted turns run at once", async () => {
  const running = new Set<string>();
  let together = false;
  const release = Promise.withResolvers<void>();

  const { workspace, middleId } = await helperWorkspace(async (run) => {
    const opening = openingOf(run);
    const which = ['First brief.', 'Second brief.'].find((brief) => opening.includes(brief));

    if (which === undefined) return chatCompletion(run, 'ok');
    running.add(which);
    together ||= running.size === 2;
    await release.promise;

    return chatCompletion(run, `${which} done`);
  });

  const other = await hostedSubordinateHarness(workspace, {
    name: 'other', displayName: 'Other', nameOrigin: 'user', mission: 'coordinate too',
  });

  await wakeForDelegatedTask(workspace, middleId, 'First brief.');
  await wakeForDelegatedTask(workspace, other.actor.handle.actorId, 'Second brief.');
  await driveUntil(workspace, 'the two turns never ran at once', () => together);
  release.resolve();
});

// A Stop between two turns an agent has admitted: the second, already read by the agent's runner, does not run.
test("a Stop skips a turn the stopped agent's runner had already picked up", async () => {
  let secondRan = false;
  let firstHeld = false;

  const { workspace, middleId } = await helperWorkspace((run) => {
    const opening = openingOf(run);

    if (opening.includes('Second queued.')) {
      secondRan = true;

      return chatCompletion(run, 'second ran');
    }

    if (opening.includes('First queued.')) {
      firstHeld = true;

      return heldUntilAborted(run);
    }

    return chatCompletion(run, 'ok');
  });

  const sql = sqlOver(workspace.db);
  const parent = sql<{ id: string }>`SELECT actor_id AS id FROM workspace_actors WHERE actor_id = ${middleId}`[0]?.id ?? '';

  // Both admitted before the runner reads the queue, so one pass holds both.
  const child = actorOver(workspace.db, parent);
  admitSubordinateTask(new EventLog(makeSqlExec(workspace.db), child), {
    fromWorkspace: child.workspaceId, kind: 'task', body: 'First queued.', mode: 'build', now: Date.now(),
  });
  await wakeForDelegatedTask(workspace, parent, 'Second queued.');
  await driveUntil(workspace, 'the first turn never started', () => firstHeld);

  // The helper is below the root: the root's Stop reaches it.
  await workspace.agent.cancelCurrentWork();

  await expect(driveUntil(workspace, 'the second turn never ran', () => secondRan)).rejects.toThrow('the second turn never ran');
});

// A facet's CPU budget is about 30 s for whatever runs under one call into it, and a turn held inside the call that
// handed it over died after 22 steps (platform catalog do.facet.cpu_ms): each step is run under a call of its own.
test("each model step of a hired agent's turn runs under a call its workspace makes into it", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => toolResults(run) < 2
    ? toolCallCompletion(run, { tool: 'eval', args: { code: 'return 1' } }, `call_${String(toolResults(run))}`)
    : chatCompletion(run, 'Counted.')));

  const child = await hostedSubordinateHarness(workspace, { name: 'counter', displayName: 'Counter', nameOrigin: 'user', mission: 'count' });

  await runDelegatedTask(workspace, child.actor.handle.actorId, 'Count twice.');

  expect(workspace.agent.harnessAgentTraceCalls().filter((call) => call === 'paceStep')).toHaveLength(3);
  expect(agentSql(child.actor.handle.actorId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${child.actor.handle.actorId} AND type = 'run_end'`[0]?.n).toBe(1);
});
