/**
 * Added agents are hired with a blank display name. Hosted actors have no chat session (no `auto_title`
 * effect), so admission of the first message applies the shared title plan.
 */

import { describe, expect, test } from 'bun:test';
import { codenameFor } from '@kinu.run/core';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

const WORKSPACE_MISSION = 'Keep the release train moving.';

async function addedAgent(seed: {
  name?: string;
  displayName: string;
  nameOrigin: 'user' | 'auto';
  roleId?: string;
  mission?: string;
}) {
  const parent = orchestratorHarness();
  const name = seed.name ?? 'quiet-harbor-1a4e20';

  const child = await hostedSubordinateHarness(parent, {
    name,
    displayName: seed.displayName,
    nameOrigin: seed.nameOrigin,
    mission: seed.mission ?? WORKSPACE_MISSION,
    roleId: seed.roleId ?? 'task',
  });

  // Without the roster link the child exists but nobody lists it, and rename refuses it.
  parent.agent.harnessRoster().create({
    name,
    actorReference: { ...child.actor.reference },
    birth: null,
    deleteRequested: false,
    createdBy: 'user',
    status: 'idle',
    currentTask: null,
    createdAt: 1,
    dismissedAt: null,
    lifetime: 'durable',
    taskEventId: null,
  });

  return { parent, child, name };
}

async function displayedName(
  parent: Awaited<ReturnType<typeof addedAgent>>['parent'], name: string,
): Promise<string> {
  return (await parent.agent.listSubordinates()).find((entry) => entry.name === name)?.displayName
    ?? '';
}

describe('an agent the owner added without naming it', () => {
  test('is born with its codename, on both sides', async () => {
    const { child, parent, name } = await addedAgent({
      displayName: codenameFor('quiet-harbor-1a4e20'), nameOrigin: 'auto',
    });

    expect(child.actor.stores.config.getDisplayName()).toBe(codenameFor(name));
    // The roster row is what every reader shows.
    expect(await displayedName(parent, name)).toBe(codenameFor(name));
  });

  test('a rename wins on both sides, and a second rename wins again', async () => {
    const { child, parent, name } = await addedAgent({
      displayName: codenameFor('quiet-harbor-1a4e20'), nameOrigin: 'auto',
    });

    await parent.agent.renameSubordinateAgent(name, 'Jarvis');

    expect(child.actor.stores.config.getDisplayName()).toBe('Jarvis');
    expect(await displayedName(parent, name)).toBe('Jarvis');

    await parent.agent.renameSubordinateAgent(name, 'Just Jarvis');

    expect(child.actor.stores.config.getDisplayName()).toBe('Just Jarvis');
    expect(await displayedName(parent, name)).toBe('Just Jarvis');
  });

  test('keeps the name its owner typed', async () => {
    const { child, parent, name } = await addedAgent({
      displayName: 'Jarvis', nameOrigin: 'user',
    });

    expect(child.actor.stores.config.getDisplayName()).toBe('Jarvis');
    expect(await displayedName(parent, name)).toBe('Jarvis');
  });
});

describe('the first message to an agent the owner added without naming it', () => {
  const FIRST = 'Audit the coupon checkout';
  const TITLE = 'Audit the coupon checkout';

  test('titles the agent from that message, on both sides', async () => {
    const { child, parent, name } = await addedAgent({
      displayName: codenameFor('quiet-harbor-1a4e20'), nameOrigin: 'auto',
    });

    await parent.agent.observeSubordinateRuntime().message(name, FIRST, 'build');

    expect(child.actor.stores.config.getDisplayName()).toBe(TITLE);
    expect(await displayedName(parent, name)).toBe(TITLE);
  });

  test('keeps the first title once it has one', async () => {
    const { child, parent, name } = await addedAgent({
      displayName: codenameFor('quiet-harbor-1a4e20'), nameOrigin: 'auto',
    });

    await parent.agent.observeSubordinateRuntime().message(name, FIRST, 'build');
    await parent.agent.observeSubordinateRuntime().message(name, 'Rename it to something else', 'build');

    expect(child.actor.stores.config.getDisplayName()).toBe(TITLE);
    expect(await displayedName(parent, name)).toBe(TITLE);
  });

  test('never touches a name the owner typed', async () => {
    const { child, parent, name } = await addedAgent({
      displayName: 'Jarvis', nameOrigin: 'user',
    });

    await parent.agent.observeSubordinateRuntime().message(name, FIRST, 'build');

    expect(child.actor.stores.config.getDisplayName()).toBe('Jarvis');
    expect(await displayedName(parent, name)).toBe('Jarvis');
  });

  test('a message admission refuses before it can title', async () => {
    const { child, parent, name } = await addedAgent({
      displayName: codenameFor('quiet-harbor-1a4e20'), nameOrigin: 'auto',
    });

    await expect(parent.agent.observeSubordinateRuntime().message(name, '', 'build'))
      .rejects.toThrow();

    expect(child.actor.stores.config.getDisplayName()).toBe(codenameFor(name));
    expect(await displayedName(parent, name)).toBe(codenameFor(name));
  });
});

describe('an agent hired with a name', () => {
  // A name stated at hire stands; nothing retitles it.
  test('keeps the name it was hired with', async () => {
    const { child, parent, name } = await addedAgent({
      name: 'auditor-a1b2c3', displayName: 'Auditor', nameOrigin: 'auto',
      roleId: 'auditor', mission: 'Audit the billing path.',
    });

    expect(child.actor.stores.config.getDisplayName()).toBe('Auditor');
    expect(await displayedName(parent, name)).toBe('Auditor');
  });
});
