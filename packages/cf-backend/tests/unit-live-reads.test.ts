/**
 * An open workspace page makes no request while nothing changes: it re-reads a live read only when a
 * `reads_changed` frame names it. These drive the writers a page cannot see (a hire, the agent's own plan,
 * a parked command, a job) and read which reads the frame named.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  appendMemoryNote, isNimbusTable, LIVE_READS, READS_CHANGED_EVENT, readsWrittenBy, type LiveRead,
} from '@kinu.run/core';
import {
  chatSessionTurns, hostedSubordinateHarness, jobsOver, orchestratorHarness, reactivateOrchestratorHarness,
  type HarnessOrchestratorAgent,
} from './helpers/actor-harness';

const ReadsFrame = v.object({ type: v.literal(READS_CHANGED_EVENT), reads: v.array(v.picklist(LIVE_READS)) });

/** Ends the tick the way production's macrotask does: every owed frame goes out. */
function endTick(agent: HarnessOrchestratorAgent): void {
  for (const flush of agent.harnessOwedLiveReads.splice(0)) flush();
}

/** The reads every `reads_changed` frame since the last call named. */
function namedReads(agent: HarnessOrchestratorAgent): () => Set<LiveRead> {
  const heard: string[] = [];
  Reflect.set(agent, 'broadcast', (payload: string) => { heard.push(payload); });

  return () => {
    const named = new Set<LiveRead>();

    for (const payload of heard.splice(0)) {
      const frame = v.safeParse(ReadsFrame, JSON.parse(payload));

      if (frame.success) for (const read of frame.output.reads) named.add(read);
    }

    return named;
  };
}

async function liveRead(agent: HarnessOrchestratorAgent, read: LiveRead): Promise<void> {
  const reads: Record<LiveRead, () => Promise<object | string | null>> = {
    getExposedPorts: () => agent.getExposedPorts('workspace'),
    getToolDescriptions: () => agent.getToolDescriptions(),
    listSlates: () => agent.listSlates(),
    getEvolutionChangelog: () => agent.getEvolutionChangelog({ limit: 30 }),
    listPendingActions: () => agent.listPendingActions(),
    getMemoryContent: () => agent.getMemoryContent(),
    getExecutors: () => agent.getExecutors(),
    listBackgroundJobs: () => agent.listBackgroundJobs(),
    getWorkspaceTabPresence: () => agent.getWorkspaceTabPresence(),
    getActivePlanReview: () => agent.getActivePlanReview(),
    listWorkspaceWork: () => agent.listWorkspaceWork(),
    listWorkspaceAgents: () => agent.listWorkspaceAgents(),
    listSubordinates: () => agent.listSubordinates(),
    getQuality: () => agent.getQuality(30),
    getWorkspaceGitHub: () => agent.getWorkspaceGitHub(),
    inspectWork: () => agent.inspectWork(),
  };

  await reads[read]();
}

/** Tables a live read selects from that no write to moves it, each with the writer that tells the page instead. */
const MOVED_ELSEWHERE = new Map([
  ['actor_config', 'the changelog reads only its seen marker, whose one writer names the reads'],
  ['sqlite_master', 'schema probe'],
  ['workspace_actors', 'identity lookup'],
  ['workspace_identity', 'identity lookup'],
  ['memory_note_files', 'the memory read looks at its note\'s stamp only to re-index it; it answers the note, whose file events name it'],
  ['conversation_entries', "the work mode follows the root's own turns, and every page re-reads at turn end"],
  ['run_events', 'the changelog reads only promotions and rollbacks, each written with its scaffold_versions row; '
    + "the agents list reads each agent's figures, which move when its turn settles its actor_turn_claims row"],
  ['cf_agents_jobs', "the work read asks the agents whose wake is armed; the SDK's queue writes pass no watched statement, "
    + 'so the agent wakes name the read on each arm and cancel'],
]);

test('every table a live read selects from is one whose writes name that read', async () => {
  const { agent } = orchestratorHarness();
  await agent.getWorkspaceSnapshot();
  const queries = agent.harnessRecordQueries();

  const unwatched: string[] = [];

  for (const read of LIVE_READS) {
    queries.length = 0;
    await liveRead(agent, read);

    for (const query of queries) {
      for (const [, table = '', call] of query.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_]\w*)(\s*\()?/gi)) {
        if (call !== undefined) continue; // Table-valued functions read arguments, not a table with writers.

        // Kinu writes no Nimbus row: file events and the port registry move the reads over them, whatever tables
        // a Nimbus release adds (2026-10-02: 0.14's vfs_tombstones, read on a path lookup that misses).
        if (isNimbusTable(table)) continue;
        const moves = readsWrittenBy(`INSERT INTO ${table}`);

        if (!moves.includes(read) && !MOVED_ELSEWHERE.has(table)) unwatched.push(`${read} <- ${table}`);
      }
    }
  }

  expect([...new Set(unwatched)]).toEqual([]);
});

// 2026-09-26: each wake of an idle workspace re-chowned its agent's home, whose file events told every open page
// its Changes moved.
test('a wake over surviving storage tells an open page nothing', async () => {
  const first = orchestratorHarness();
  await first.agent.getWorkspaceSnapshot();
  const heard: string[] = [];

  const woken = await reactivateOrchestratorHarness(first.db, undefined, {
    beforeStart: (agent) => { Reflect.set(agent, 'broadcast', (payload: string) => { heard.push(payload); }); },
  });

  await woken.agent.getWorkspaceSnapshot();
  endTick(woken.agent);

  expect(heard).toEqual([]);
});

test('reading every live read names none, so a page that re-reads on a frame never loops', async () => {
  const { agent } = orchestratorHarness();
  const named = namedReads(agent);
  await agent.getWorkspaceSnapshot();
  endTick(agent);
  named();

  for (const read of LIVE_READS) await liveRead(agent, read);
  endTick(agent);
  expect(named()).toEqual(new Set());
});

test("the agent's own plan names the plan and the needs-you queue", async () => {
  const { agent } = orchestratorHarness();
  const named = namedReads(agent);
  agent.harnessDrivingUserMessage('plan this change', { kinuMode: 'plan' });
  const turns = chatSessionTurns(agent);
  const { tools } = await turns.prepare({ messages: [{ role: 'user', content: 'plan this change' }] });
  endTick(agent);
  named();

  await tools.submit_plan?.execute?.({ edits: [{ start: 1, content: '# Plan' }] }, { toolCallId: 'p', messages: [], context: undefined });
  endTick(agent);

  expect([...named()]).toEqual(expect.arrayContaining(['getActivePlanReview', 'listPendingActions']));
  await turns.settle({ messageId: 'a-plan', text: 'planned' });
});

test('a command parked for approval names the needs-you queue', async () => {
  const { agent } = orchestratorHarness();
  const named = namedReads(agent);
  await agent.setShellApprovalMode('strict');
  endTick(agent);
  named();

  await agent.executeInExecutor('workspace', 'git push --force origin main');
  endTick(agent);

  expect(named()).toContain('listPendingActions');
});

test("a hire's memory note names the memory read and the tab presence", async () => {
  const workspace = orchestratorHarness();

  const hire = await hostedSubordinateHarness(workspace, {
    name: 'scribe-1', displayName: 'Scribe', nameOrigin: 'user', roleId: 'task', mission: 'take notes',
  });

  const named = namedReads(workspace.agent);
  endTick(workspace.agent);
  named();

  await appendMemoryNote(hire.actor.runtime.memory, 'the build needs node 22');
  endTick(workspace.agent);

  expect(named()).toEqual(new Set(['getMemoryContent', 'getWorkspaceTabPresence']));
});

test('a crafted tool and the changelog seen mark each name what they move', async () => {
  const { agent } = orchestratorHarness();
  const named = namedReads(agent);
  agent.harnessDrivingUserMessage('make a tool', {});
  const turns = chatSessionTurns(agent);
  const { tools } = await turns.prepare({ messages: [{ role: 'user', content: 'make a tool' }] });
  endTick(agent);
  named();

  const code = "await workspace.createTool('tally', 'count', 'async () => 1')";
  await tools.eval?.execute?.({ code }, { toolCallId: 'c', messages: [], context: undefined });
  endTick(agent);
  expect(named()).toContain('getToolDescriptions');

  await agent.markChangelogSeen();
  endTick(agent);
  expect(named()).toContain('getEvolutionChangelog');
  await turns.settle({ messageId: 'a-tool', text: 'made' });
});

test('a rating names the quality read, so an open Quality tab shows it', async () => {
  const { agent } = orchestratorHarness();
  const named = namedReads(agent);
  await agent.getWorkspaceSnapshot();
  endTick(agent);
  named();

  await agent.setTurnFeedback('m-1', 'positive');
  endTick(agent);
  expect(named()).toContain('getQuality');
});

test('an agent dismissed names the Agents panel and the roster', async () => {
  const { agent } = orchestratorHarness();
  await agent.setSoul('# Purpose\n\nShip the coupon fix.');
  const { name } = await agent.createSubordinateAgent();
  const named = namedReads(agent);
  endTick(agent);
  named();

  await agent.dismissSubordinate(name);
  endTick(agent);

  expect([...named()]).toEqual(expect.arrayContaining(['listWorkspaceAgents', 'listSubordinates']));
});

// eval-site-preview-1-2ypddc, staging f75f06932, 2026-10-01: the eval's settle read the jobs every second because it
// had no other way to learn one ended; the room's frame for the jobs read is that way.
test('a job that ends names the jobs read', async () => {
  const { agent, db } = orchestratorHarness();
  jobsOver(db).create({ id: 'bgjob-build', kind: 'shell', workMode: 'build', now: Date.now(), label: 'build', input: '{"command":"build"}' });
  const named = namedReads(agent);
  endTick(agent);
  named();

  expect(await agent.cancelBackgroundJob('bgjob-build')).toEqual({ ok: true });
  endTick(agent);

  expect(named()).toContain('listBackgroundJobs');
});

/** Each agent's label and activity, read when called. */
async function activities(agent: HarnessOrchestratorAgent): Promise<Record<string, string>> {
  return Object.fromEntries((await agent.listWorkspaceAgents()).map((row) => [row.label, row.activity]));
}

const WAKE = { metadata: { kinuEvent: 'background_job' } };

// Staging f75f06932, 2026-10-01: the eval's settle called trials quiet on idle reads while a turn was owed and not yet
// claimed. A turn reads working from its enqueue, and the pump's start and end each name the Agents panel.
test('a job\'s wake queued for Main reads working before its turn claims, and the pump\'s start and end name the Agents panel', async () => {
  const { agent } = orchestratorHarness();
  const turns = chatSessionTurns(agent);
  const opened = turns.park();
  const named = namedReads(agent);
  await agent.getWorkspaceSnapshot();
  endTick(agent);
  named();

  const woken = turns.enqueue('Background shell job bgjob-build completed.', WAKE);
  const atEnqueue = activities(agent);
  endTick(agent);

  expect(named()).toContain('listWorkspaceAgents');
  expect(await atEnqueue).toEqual({ Main: 'working' });

  await opened;
  await turns.settle({ messageId: 'a-wake', text: 'Noted.' });
  await woken;
  endTick(agent);

  expect(named()).toContain('listWorkspaceAgents');
  expect(await activities(agent)).toEqual({ Main: 'idle' });
});

// A turn the driver refuses at dequeue settles to its producer and leaves the queue: it cannot read working past the pump.
test('a wake the driver refuses reads idle once the pump has refused it, and the pump\'s end names the Agents panel', async () => {
  const { agent } = orchestratorHarness();
  const turns = chatSessionTurns(agent);
  const named = namedReads(agent);
  await agent.getWorkspaceSnapshot();
  agent.harnessRefuseDriving({ reason: 'unavailable', error: 'another activation is driving' });
  endTick(agent);
  named();

  const woken = turns.enqueue('Background shell job bgjob-build completed.', WAKE);
  const atEnqueue = activities(agent);
  endTick(agent);
  named();
  expect(await atEnqueue).toEqual({ Main: 'working' });

  await woken;
  await turns.drainEnqueued();
  endTick(agent);

  expect(named()).toContain('listWorkspaceAgents');
  expect(await activities(agent)).toEqual({ Main: 'idle' });
});

// An email to Main is held for the drain its delivery armed: Main owes it a turn from the delivery on.
test('an email delivered to Main reads working until its drain takes it, and the delivery names the Agents panel', async () => {
  const { agent } = orchestratorHarness({ warmConnections: [], failWarm: null, titles: [], profile: { email: 'owner@example.com' } });
  const named = namedReads(agent);
  await agent.getWorkspaceSnapshot();
  endTick(agent);
  named();

  const admission = await agent.acceptEmailDelivery({
    from: 'owner@example.com', to: 'workspace@kinu.run', subject: 'status?', body_text: 'how is the deploy?',
    message_id: '<m-1@example.com>', in_reply_to: null, references: null, attachments: [], now: Date.now(),
  });

  endTick(agent);

  expect(admission).toMatchObject({ admitted: true, duplicate: false });
  expect(named()).toContain('listWorkspaceAgents');
  expect(await activities(agent)).toEqual({ Main: 'working' });
});

// Staging f75f06932: a helper handed a task read idle until its drain claimed it.
test('an agent handed a message reads working from the handoff, before its drain runs, and the handoff names the Agents panel', async () => {
  const { agent } = orchestratorHarness();
  await agent.setSoul('# Purpose\n\nShip the coupon fix.');
  const { name } = await agent.createSubordinateAgent();
  await agent.renameSubordinateAgent(name, 'Scribe');
  agent.harnessDrivingUserMessage('ask the scribe', {});
  const turns = chatSessionTurns(agent);
  const { tools } = await turns.prepare({ messages: [{ role: 'user', content: 'ask the scribe' }] });
  const named = namedReads(agent);
  endTick(agent);
  named();
  expect((await activities(agent)).Scribe).toBe('idle');

  await tools.agents?.execute?.({ action: 'msg', agent: name, message: 'Count the files.' }, { toolCallId: 'm', messages: [], context: undefined });
  endTick(agent);

  expect(named()).toContain('listWorkspaceAgents');
  expect((await activities(agent)).Scribe).toBe('working');
  await turns.settle({ messageId: 'a-msg', text: 'asked' });
});
