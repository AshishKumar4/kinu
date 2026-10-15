/**
 * An agent's settled turn owes effects its own isolate runs after the turn, against its workspace. Staging 0e094da7d
 * (2026-10-14 21:19:03Z): the owner dismissed an agent they added a second after its first answer, and the turn's
 * auto_title ran into the dismissed identity and was logged a failed effect. A dismissed agent's name and its advisor
 * are no one's concern: what its turn owed them stands down.
 */
import { expect, test } from 'bun:test';
import { setDiagnosticsSink } from '@kinu.run/core/obs';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { orchestratorHarness } from './helpers/actor-harness';
import { createRecordingLogger } from '@kinu.run/test-utils';

test("an agent dismissed before its turn's effects ran owes no title: the effect stands down, and nothing is renamed", async () => {
  const workspace = orchestratorHarness();
  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');
  const { name, subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = subordinate.actorId ?? '';
  // The port its isolate already holds, as the turn's effects find it after the dismissal.
  const port = await workspace.agent.agentWorkspace(actorId);

  await workspace.agent.dismissSubordinate(name, true);
  // The dismissal's retirement, which ends the agent's identity, lands before the effects run, as it did on staging.
  await joinHarnessFibers();
  const log = createRecordingLogger();
  const restore = setDiagnosticsSink(log);

  // Asked as its isolate asks, for the mission to name the agent after: none, so no name is drawn or written.
  await expect(port.autoTitle('Reply with only the word CHARLIE', null)).resolves.toBeNull();
  await expect(port.autoTitle('Reply with only the word CHARLIE', 'Charlie')).resolves.toBeNull();
  expect((await workspace.agent.listSubordinates()).find((entry) => entry.name === name)?.displayName).not.toBe('Charlie');
  expect(log.emitted.filter((line) => line.event === 'turn.terminal_effect_ended').map((line) => line.fields))
    .toEqual([{ actor: actorId, effect: 'auto_title', standing: 'retired' }, { actor: actorId, effect: 'auto_title', standing: 'retired' }]);
  restore();
  await joinHarnessFibers();
});
