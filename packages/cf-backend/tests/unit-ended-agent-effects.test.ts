/**
 * An agent's settled turn owes effects its own isolate runs after the turn, against its workspace. Staging 0e094da7d
 * (2026-10-14 21:19:03Z): the owner dismissed an agent they added a second after its first answer, and the turn's
 * auto_title ran into the dismissed identity and was logged a failed effect. A dismissed agent's name and its advisor
 * are no one's concern: what its turn owed them stands down.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import { setDiagnosticsSink } from '@kinu.run/core/obs';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { gatewayWorkspace, orchestratorHarness, runDelegatedTask, until } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding } from './helpers/platform-gateway';
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

test("an agent dismissed while its isolate draws its name owes no title: the draw the workspace then refuses stands down", async () => {
  const titling = { asked: 0 };

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (!JSON.stringify(requestOf(run).messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT)) return chatCompletion(run, 'Hello.');
    titling.asked += 1;

    return chatCompletion(run, JSON.stringify({ title: 'Greeter' }));
  }));

  await workspace.agent.setSoul('# Purpose\n\nGreet whoever asks.');
  const { name, subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = v.parse(v.string(), subordinate.actorId);
  const open = workspace.agent.agentWorkspace.bind(workspace.agent);

  // The owner dismisses the agent once the workspace has planned its title, as on staging c595a3e6b (17:31:38Z): its
  // isolate prepares the draw of the name after, from an identity the dismissal has ended. The harness's object answers
  // each call as a stub does, so the port it hands the isolate is awaited.
  Object.assign(workspace.agent, {
    agentWorkspace: async (id: string) => {
      const port = await open(id);
      const plan = port.autoTitle.bind(port);

      if (id === actorId) {
        port.autoTitle = async (subject, title) => {
          const mission = await plan(subject, title);

          if (title === null && mission !== null) await workspace.agent.dismissSubordinate(name, true);

          return mission;
        };
      }

      return port;
    },
  });
  const log = createRecordingLogger();
  const restore = setDiagnosticsSink(log);
  const told = (event: string) => log.emitted.filter((line) => line.event === event && JSON.stringify(line.fields).includes('auto_title'));

  await runDelegatedTask(workspace, actorId, 'Say hello.');
  await until(() => told('turn.terminal_effect_failed').length + told('turn.terminal_effect_ended').length > 0, "the agent's title settled");
  restore();
  expect(told('turn.terminal_effect_failed').map((line) => line.fields)).toEqual([]);
  expect(told('turn.terminal_effect_ended').map((line) => line.fields)).toEqual([{ actor: actorId, effect: 'auto_title', standing: 'retired' }]);
  expect(titling.asked).toBe(0);
  await joinHarnessFibers();
});
