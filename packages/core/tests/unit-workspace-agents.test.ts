// Defends: an agent the panel cannot see, a hired or background agent given a tab or a composer, a swarm worker
// left out or shown working after its run ended.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestActors } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers';
import { initHeadsTables } from '../src/heads/schema';
import { initSearchTables } from '../src/mcts/schemas';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { initSwarmNodeRecords } from '../src/strategy/swarm-resume';
import { SubordinateRosterStore } from '../src/subordinates/roster';
import { actorReferenceOf, type ActorHandle } from '../src/identity/actor-handle';
import type { SubordinateRosterEntry } from '../src/delegation/agents-tool';
import { agentActive, readWorkspaceAgents, type PanelAgent } from '../src/read-models/workspace-agents';

function workspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const exec = makeSqlExec(db);
  initSearchTables(execRaw);
  initMctsSearchTable(execRaw);
  initHeadsTables(execRaw);
  initSwarmNodeRecords(execRaw);
  const actors = createTestActors(sql, execRaw);
  new SubordinateRosterStore(exec, actors.main).ensureSchema();

  const hire = (parent: ActorHandle, name: string, entry: Partial<SubordinateRosterEntry>): ActorHandle => {
    const child = actors.directory.create({ parent, name, kind: 'subordinate', lifetime: 'durable', creationId: name });

    new SubordinateRosterStore(exec, parent).create({
      name, actorReference: actorReferenceOf(child), birth: null, deleteRequested: false, createdBy: 'orchestrator',
      status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null, ...entry,
    });

    return child;
  };

  const read = (): PanelAgent[] => readWorkspaceAgents({
    sql, exec, root: actors.main, rootLabel: 'Kinu', actors: actors.directory.list({ retired: true }),
  });

  return { db, main: actors.main, hire, read };
}

const byLabel = <T extends { label: string }>(rows: T[]): T[] => rows.sort((a, b) => a.label.localeCompare(b.label));

const row = ({ label, category, activity, parent, tab, input, open }: PanelAgent) => ({ label, category, activity, parent, tab, input, open });

describe('the Agents panel lists every agent in the workspace', () => {
  test('the owner\'s own, one an agent hired, and a background helper, each placed as the design says', () => {
    const { db, main, hire, read } = workspace();
    const alice = hire(main, 'alice', { createdBy: 'user' });
    hire(alice, 'scout-1', { status: 'working' });
    hire(main, 'refiner-1', { createdBy: 'evolution', lifetime: 'task' });
    hire(main, 'lookup-1', { lifetime: 'task', status: 'working' });
    // Creation times tie within a millisecond; a child listed before its parent still sits under it.
    db.query('UPDATE workspace_actors SET created_at = 0 WHERE name = ?').run('scout-1');

    expect(byLabel(read().map(row))).toEqual(byLabel([
      { label: 'alice', category: 'user', activity: 'idle', parent: 'Kinu', tab: true, input: true, open: { kind: 'chat', path: 'alice' } },
      { label: 'scout-1', category: 'hired', activity: 'working', parent: 'alice', tab: false, input: true, open: { kind: 'chat', path: 'alice/scout-1' } },
      { label: 'refiner-1', category: 'background', activity: 'idle', parent: 'Kinu', tab: false, input: false, open: { kind: 'chat', path: 'refiner-1' } },
      { label: 'lookup-1', category: 'hired', activity: 'working', parent: 'Kinu', tab: false, input: true, open: { kind: 'chat', path: 'lookup-1' } },
    ]));
    expect(read().filter((agent) => agentActive(agent) && !agent.tab).map((agent) => agent.label).sort()).toEqual(['lookup-1', 'scout-1']);
  });

  test('a swarm\'s workers are listed under the agent that started it: working while the run runs, read-only', () => {
    const { db, main, read } = workspace();
    db.query('INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at) VALUES (?, ?, ?, ?)').run(main.actorId, 'run-1', 'compare two parsers', 10);

    const head = db.query(`INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
      VALUES (?, ?, NULL, 'run-1', 0, ?, 'r', ?, ?, 'synthesize')`);

    head.run(main.actorId, 'h-a', 'Try the PEG parser', 'running', 11);
    head.run(main.actorId, 'h-b', 'Try the Pratt parser', 'completed', 12);

    const workers = read().filter((agent) => agent.category === 'swarm').map(row);

    expect(workers).toEqual([
      { label: 'Try the PEG parser', category: 'swarm', activity: 'working', parent: 'Kinu', tab: false, input: false, open: { kind: 'node', runId: 'run-1', nodeId: 'h-a', owner: null } },
      { label: 'Try the Pratt parser', category: 'swarm', activity: 'done', parent: 'Kinu', tab: false, input: false, open: { kind: 'node', runId: 'run-1', nodeId: 'h-b', owner: null } },
    ]);
    expect(read().filter(agentActive).map((agent) => agent.label)).toEqual(['Try the PEG parser']);
  });
});
