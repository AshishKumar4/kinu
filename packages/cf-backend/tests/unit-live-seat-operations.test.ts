import { expect, test } from 'bun:test';
import type { ActorSeat, OperationCaller } from '@kinu.run/core';
import { hostedExplorationHarness, orchestratorHarness } from './helpers/actor-harness';

const kinds: readonly ('head' | 'node')[] = ['head', 'node'];

for (const kind of kinds) {
  test(`a live ${kind} keeps its seat while public operations and a hosted slate call mutate its own state`, async () => {
    const workspace = orchestratorHarness();
    const seat: ActorSeat = { kind };
    const id = `live-${kind}`;

    const { actor } = await hostedExplorationHarness(workspace, id, seat);
    const caller = { actorId: actor.handle.actorId, turnId: null, mode: 'build' } satisfies OperationCaller;

    const listed = await workspace.agent.listOperations(caller);

    expect(listed.map((operation) => operation.id)).toContain('state.get');
    await workspace.agent.callOperation(caller, 'state.set', { key: 'generic', value: 'operation' }, { callId: 'generic-write' });
    expect((await workspace.agent.callOperation(caller, 'state.get', { key: 'generic' }, { callId: 'generic-read' })).value).toBe('operation');

    const context = { nested: () => {} };

    await workspace.agent.slateCallDispatch([{ name: actor.record.name }], {
      kind: 'namespace', namespace: 'db', member: 'createTable',
      args: [{ name: 'seat_notes', scope: 'actor', columns: [{ name: 'note', type: 'text' }] }],
    }, 'build', context);
    await workspace.agent.slateCallDispatch([{ name: actor.record.name }], {
      kind: 'namespace', namespace: 'db', member: 'insert',
      args: ['seat_notes', [{ note: 'retained seat' }]],
    }, 'build', context);
    expect(await workspace.agent.slateCallDispatch([{ name: actor.record.name }], {
      kind: 'namespace', namespace: 'db', member: 'select', args: ['seat_notes'],
    }, 'build', context)).toEqual([{ note: 'retained seat' }]);
    expect(await workspace.agent.slateCallDispatch([], {
      kind: 'namespace', namespace: 'db', member: 'select', args: ['seat_notes'],
    }, 'build', context)).toEqual([]);
    expect((await hostedExplorationHarness(workspace, id, seat)).actor).toBe(actor);
  });
}
