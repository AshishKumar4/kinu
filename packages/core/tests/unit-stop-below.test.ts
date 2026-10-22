// Defends: a Stop below an agent doing the same on every host. The cloud's directory retired a stopped task agent's
// hires with it but left them counted working on its roster; the CLI dismissed them first. Both now run core's
// `stopAgentsBelow` (cf-backend/tests/unit-stop-below.test.ts drives the cloud's).
import { describe, expect, test } from 'bun:test';
import { stopAgentsBelow } from '../src/subagents/hire-lifecycle';
import type { WorkspaceActor } from '../src/identity/workspace-actors';
import type { ActorReference } from '../src/identity/actor-handle';
import type { SubagentRosterEntry } from '../src/delegation/agents-tool';

function actor(actorId: string, parentActorId: string | null, name: string, lifetime: 'task' | 'durable'): WorkspaceActor {
  return {
    actorId, parentActorId, workspaceId: 'w', name, storageKey: name, origin: parentActorId === null ? 'system' : 'agent', lifetime,
    tab: false, input: true, evolves: false, creationId: `c-${actorId}`, createdAt: 1, retiringAt: null, deletedAt: null,
  };
}

/** Main hired `lead` for a task; `lead` hired `docs`, durable; Main also runs `busy`, mid-turn. */
const ACTORS = [
  actor('main', null, 'main', 'durable'),
  actor('lead', 'main', 'lead', 'task'),
  actor('docs', 'lead', 'docs', 'durable'),
  actor('busy', 'main', 'busy', 'task'),
];

function world() {
  const byId = new Map(ACTORS.map((row) => [row.actorId, row]));
  const status = new Map<string, SubagentRosterEntry['status']>([['lead', 'working'], ['docs', 'working'], ['busy', 'working']]);
  const acts: string[] = [];

  const entry = (name: string, now: SubagentRosterEntry['status']): SubagentRosterEntry => ({
    name, actorReference: null, birth: null, deleteRequested: false, origin: 'agent', status: now, currentTask: null, createdAt: 1,
    dismissedAt: null, lifetime: 'task', taskEventId: null,
  });

  const roster = (_hirer: ActorReference) => ({
    get: (name: string) => {
      const now = status.get(name);

      return now === undefined ? null : entry(name, now);
    },
    dismiss: (name: string) => { status.set(name, 'dismissed'); acts.push(`dismiss ${name}`); },
    // A report other than progress leaves it at rest.
    applyReport: (name: string, next: 'blocked' | 'completed' | 'progress') => { status.set(name, next === 'progress' ? 'working' : 'idle'); acts.push(`${next} ${name}`); },
  });

  return {
    acts, status,
    ports: {
      directory: { list: () => ACTORS, retained: (id: string) => byId.get(id) ?? null },
      roster,
      retire: async (owner: ActorReference, retirement: { readonly name: string; readonly destroy: boolean }) => {
        acts.push(`retire ${retirement.name} under ${owner.actorId}${retirement.destroy ? ' destroyed' : ''}`);
      },
      cancelOwed: (row: WorkspaceActor) => { acts.push(`cancel ${row.name}`); },
      stopTurn: async (row: WorkspaceActor) => {
        acts.push(`cut ${row.name}`);

        return row.actorId === 'busy';
      },
    },
  };
}

describe('a Stop below an agent', () => {
  test('cuts every turn, blocks what rests, and retires a stopped task agent with its hires first, history kept', async () => {
    const { acts, status, ports } = world();

    await stopAgentsBelow('main', ports);

    // Deepest first (`stoppedBelow`): `docs` is blocked before its hirer is retired, and dismissed with it.
    expect(acts).toEqual([
      'cancel docs', 'cut docs', 'blocked docs',
      'cancel lead', 'cut lead', 'blocked lead', 'dismiss docs', 'retire docs under lead', 'retire lead under main',
      'cancel busy', 'cut busy',
    ]);

    expect(status.get('busy')).toBe('working');
  });
});
