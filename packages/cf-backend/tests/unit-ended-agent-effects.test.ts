/**
 * An agent's settled turn owes effects its own isolate runs after the turn, against its workspace. Once the owner
 * dismisses the agent, the workspace refuses them: staging c595a3e6b failed a dismissed agent's auto_title ("The actor
 * identity is no longer present"), and d763adae4 a retired helper's turn_report ("Agent stand-one-question is retired").
 * What an agent that no longer acts owed is no one's concern: each stands down, logged as ended, never as a failure.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import { KinuError, setDiagnosticsSink } from '@kinu.run/core/obs';
import type { AgentWorkspaceHost } from '../src/agent-facets';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { gatewayWorkspace, runDelegatedTask, until } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding } from './helpers/platform-gateway';
import { createRecordingLogger } from '@kinu.run/test-utils';

/**
 * An added agent's delegated task, run as production runs one, with `dismissing` installed on the port its isolate is
 * handed: it is told how to dismiss the agent, as the owner does, in the middle of whichever effect it picks. Answers
 * the effects the turn's settle logged ended and failed, read once `effect` settled, and how many names were drawn.
 */
async function dismissedWhile(effect: string, dismissing: (port: AgentWorkspaceHost, dismiss: () => Promise<void>) => void) {
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

  // The harness's object answers each call as a stub does, so the port it hands the isolate is awaited.
  Object.assign(workspace.agent, {
    agentWorkspace: async (id: string) => {
      const port = await open(id);

      if (id === actorId) dismissing(port, async () => { await workspace.agent.dismissSubordinate(name, true); });

      return port;
    },
  });
  const log = createRecordingLogger();
  const restore = setDiagnosticsSink(log);
  const told = (event: string) => log.emitted.filter((line) => line.event === event && JSON.stringify(line.fields).includes(effect)).map((line) => line.fields);

  await runDelegatedTask(workspace, actorId, 'Say hello.');
  await until(() => told('turn.terminal_effect_failed').length + told('turn.terminal_effect_ended').length > 0, `the agent's ${effect} settled`);
  restore();
  await joinHarnessFibers();

  return { ended: told('turn.terminal_effect_ended'), failed: told('turn.terminal_effect_failed'), drawn: titling.asked };
}

test("an agent dismissed while its isolate draws its name owes no title: the draw the workspace refuses stands down", async () => {
  // Once the workspace has planned its title, as on staging c595a3e6b (17:31:38Z): the isolate prepares the draw of the
  // name after, from an identity the dismissal has ended.
  const { ended, failed, drawn } = await dismissedWhile('auto_title', (port, dismiss) => {
    const plan = port.autoTitle.bind(port);

    port.autoTitle = async (subject, title) => {
      const mission = await plan(subject, title);

      if (title === null && mission !== null) await dismiss();

      return mission;
    };
  });

  expect(failed).toEqual([]);
  expect(ended).toEqual([expect.objectContaining({ effect: expect.stringContaining('auto_title'), standing: 'retired' })]);
  expect(drawn).toBe(0);
});

test("a helper retired as its turn's report is relayed owes its hirer nothing: the report the workspace refuses stands down", async () => {
  // As on staging d763adae4 (14:04:46.720Z): the helper's report reached a workspace that had retired it.
  const { ended, failed } = await dismissedWhile('turn_report', (port, dismiss) => {
    const report = port.turnReport.bind(port);

    port.turnReport = async (...args) => {
      await dismiss();

      return await report(...args);
    };
  });

  expect(failed).toEqual([]);
  expect(ended).toEqual([expect.objectContaining({ effect: expect.stringContaining('turn_report'), standing: 'retired' })]);
});

// Review of 66938aa25: the isolate read the standing off the refusal's text, so a live helper's failure quoting it
// ended its report unsent.
test("a live helper whose report's relay fails quoting an ended refusal's words still owes it: the failure is its own", async () => {
  const { ended, failed } = await dismissedWhile('turn_report', (port) => {
    port.turnReport = async () => {
      throw new KinuError('unavailable', 'the relay answered: actor_ended(retired): Agent task is retired and no longer acts in this workspace.');
    };
  });

  expect(ended).toEqual([]);
  expect(failed).toEqual([expect.objectContaining({ effect: expect.stringContaining('turn_report') })]);
});
