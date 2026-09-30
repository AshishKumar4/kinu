/**
 * An open workspace page makes no request while nothing changes: it re-reads a live read only when a
 * `reads_changed` frame names it. These drive the writers a page cannot see (a hire, the agent's own plan,
 * a parked command, a job) and read which reads the frame named.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  appendMemoryNote, LIVE_READS, READS_CHANGED_EVENT, readsWrittenBy, type LiveRead,
} from '@kinu.run/core';
import {
  chatSessionTurns, hostedSubordinateHarness, orchestratorHarness, reactivateOrchestratorHarness,
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
  };

  await reads[read]();
}

/** Tables a live read selects from that no write to moves it, each with the writer that tells the page instead. */
const MOVED_ELSEWHERE = new Map([
  ['actor_config', 'the changelog reads only its seen marker, whose one writer names the reads'],
  ['sqlite_master', 'schema probe'],
  ['workspace_actors', 'identity lookup'],
  ['workspace_identity', 'identity lookup'],
  ['conversation_entries', "the work mode follows the root's own turns, and every page re-reads at turn end"],
  ['run_events', 'the changelog reads only promotions and rollbacks, each written with its scaffold_versions row; '
    + "the agents list reads each agent's figures, which move when its turn settles its actor_turn_claims row"],
  ['vfs_inodes', 'Nimbus file rows: file events, not table writes, move the reads over workspace files'],
  ['vfs_chunks', 'workspace ports move with the port registry'],
  ['nimbus_session_kv', 'workspace ports move with the port registry'],
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

  await tools.submit_plan?.execute?.({ edits: [{ start: 1, content: '# Plan' }] }, { toolCallId: 'p', messages: [] });
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
  await tools.eval?.execute?.({ code }, { toolCallId: 'c', messages: [] });
  endTick(agent);
  expect(named()).toContain('getToolDescriptions');

  await agent.markChangelogSeen();
  endTick(agent);
  expect(named()).toContain('getEvolutionChangelog');
  await turns.settle({ messageId: 'a-tool', text: 'made' });
});

test('an agent dismissed names the Agents panel', async () => {
  const { agent } = orchestratorHarness();
  await agent.setSoul('# Purpose\n\nShip the coupon fix.');
  const { name } = await agent.createSubordinateAgent();
  const named = namedReads(agent);
  endTick(agent);
  named();

  await agent.dismissSubordinate(name);
  endTick(agent);

  expect(named()).toContain('listWorkspaceAgents');
});
