/**
 * Added agents are hired with a blank display name. Hosted actors have no chat session (no `auto_title`
 * effect), so admission of the first message applies the shared title plan.
 * Agents are added, renamed and read as the owner's browser does it; a message reaches one as the main
 * actor's `agents` tool sends it, on a turn the platform gateway serves.
 */

import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { codenameFor, type JsonObject } from '@kinu.run/core';
import { catalogTurn, gatewayWorkspace, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const SOUL = '# Kinu\n\n## Mission\n\nKeep the release train moving.\n';

/** The owner's words that ask the main actor to message one agent; the model sends `message` to `agent`. */
function tell(agent: string, message: string): string {
  return `Tell ${agent}: ${message}`;
}

/** The owner's words that ask the main actor to hire `agent` in `role` for `mission`. */
function hire(agent: string, role: string, mission: string): string {
  return `Hire ${agent} as ${role}: ${mission}`;
}

const TELL = /^Tell ([^:]+): (.*)$/su;

const HIRE = /^Hire (\S+) as ([^:]+): (.*)$/su;

/** The one `agents` call the owner's words ask for, or null when they ask for none. */
function askedCall(words: string): JsonObject | null {
  const told = TELL.exec(words);

  if (told !== null) return { action: 'msg', agent: told[1] ?? '', message: told[2] ?? '' };
  const hired = HIRE.exec(words);

  return hired === null ? null : { action: 'hire', agent: hired[1] ?? '', role: hired[2] ?? '', mission: hired[3] ?? '' };
}

/**
 * The main actor's model: on the owner's latest words, the one `agents` call they ask for, then a closing
 * line. Read off the request, so a retried request answers the same way.
 */
function relayingGateway() {
  return stubAiBinding((run) => {
    const { messages } = requestOf(run);

    // Each message's call, or null: only the owner's words, which are always a string, ask for one.
    const calls = messages.map((message) => {
      const words = v.safeParse(v.string(), message.content);

      return message.role === 'user' && words.success ? askedCall(words.output) : null;
    });

    const asked = calls.reduce((latest, call, index) => call === null ? latest : index, -1);
    const call = calls[asked] ?? null;
    const answered = messages.slice(asked + 1).some((message) => message.role === 'tool');

    return call === null || answered ? chatCompletion(run, 'Done.') : toolCallCompletion(run, { tool: 'agents', args: call }, 'agents_0');
  });
}

/** An agent the owner added from the browser: a codename, and the workspace's mission. */
async function addedAgent(): Promise<{ parent: ActorHarness<HarnessOrchestratorAgent>; name: string }> {
  const parent = gatewayWorkspace(relayingGateway());
  await parent.agent.setSoul(SOUL);
  const { name } = await parent.agent.createSubordinateAgent();

  return { parent, name };
}

/** The name each side shows: the agent's own pane, and the parent's roster. */
async function shownNames(parent: ActorHarness<HarnessOrchestratorAgent>, name: string): Promise<[string, string]> {
  const own = (await parent.agent.getActorSnapshot(name)).displayName;
  const listed = (await parent.agent.listSubordinates()).find((entry) => entry.name === name)?.displayName ?? '';

  return [own, listed];
}

describe('an agent the owner added without naming it', () => {
  test('is born with its codename, on both sides', async () => {
    const { parent, name } = await addedAgent();

    expect(await shownNames(parent, name)).toEqual([codenameFor(name), codenameFor(name)]);
  });

  test('a rename wins on both sides, and a second rename wins again', async () => {
    const { parent, name } = await addedAgent();

    await parent.agent.renameSubordinateAgent(name, 'Jarvis');
    expect(await shownNames(parent, name)).toEqual(['Jarvis', 'Jarvis']);

    await parent.agent.renameSubordinateAgent(name, 'Just Jarvis');
    expect(await shownNames(parent, name)).toEqual(['Just Jarvis', 'Just Jarvis']);
  });
});

describe('the first message to an agent the owner added without naming it', () => {
  const FIRST = 'Audit the coupon checkout';
  const TITLE = 'Audit the coupon checkout';

  test('titles the agent from that message, on both sides', async () => {
    const { parent, name } = await addedAgent();

    await catalogTurn(parent.agent, tell(name, FIRST));

    expect(await shownNames(parent, name)).toEqual([TITLE, TITLE]);
  });

  test('keeps the first title once it has one', async () => {
    const { parent, name } = await addedAgent();

    await catalogTurn(parent.agent, tell(name, FIRST));
    await catalogTurn(parent.agent, tell(name, 'Rename it to something else'));

    expect(await shownNames(parent, name)).toEqual([TITLE, TITLE]);
  });

  test('never touches a name the owner typed', async () => {
    const { parent, name } = await addedAgent();
    await parent.agent.renameSubordinateAgent(name, 'Jarvis');

    await catalogTurn(parent.agent, tell(name, FIRST));

    expect(await shownNames(parent, name)).toEqual(['Jarvis', 'Jarvis']);
  });

  test('an empty message is refused and titles nothing', async () => {
    const { parent, name } = await addedAgent();

    await catalogTurn(parent.agent, tell(name, ''));

    expect(await shownNames(parent, name)).toEqual([codenameFor(name), codenameFor(name)]);
  });
});

describe('an agent hired with a name', () => {
  // A name stated at hire stands; nothing retitles it.
  test('keeps the name it was hired with', async () => {
    const parent = gatewayWorkspace(relayingGateway());

    await catalogTurn(parent.agent, hire('auditor-a1b2c3', 'task', 'Audit the billing path.'));
    const [hired] = await shownNames(parent, 'auditor-a1b2c3');
    await catalogTurn(parent.agent, tell('auditor-a1b2c3', 'Audit the coupon checkout'));

    expect(hired).not.toBe('');
    expect(await shownNames(parent, 'auditor-a1b2c3')).toEqual([hired, hired]);
  });
});
