/**
 * How an agent the owner ADDED gets its name, through hosted actors.
 *
 * The owner adds an agent to a workspace and says nothing about it: no name, no
 * mission, no role. It is hired with a blank display name, and a rename sets
 * the name the roster shows and the config keeps — on both sides, once.
 *
 * There is no first-message auto-title race to pin. Auto-titling is a terminal
 * effect of a chat turn — it fires a naming model and races the owner's own
 * rename — and hosted children hold no chat session: there is no turn to fire
 * it from and no second writer to race. A hire keeps the display name it was
 * hired with until the owner renames it, which is what these tests pin.
 */

import { describe, expect, test } from 'bun:test';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

const WORKSPACE_MISSION = 'Keep the release train moving.';

/**
 * A parent workspace with one agent added to it, through the production hire.
 * The roster row is the one every reader shows; the config is what the actor
 * itself answers.
 */
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
    roleId: seed.roleId ?? 'general',
  });
  // The roster LINK row: hiring binds stores and runtime, but the roster is
  // the reader-facing listing — without the link the child exists and nobody
  // lists it, which is exactly what the rename path below refuses.
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
  test('is born with no title', async () => {
    const { child, parent, name } = await addedAgent({
      displayName: '', nameOrigin: 'auto',
    });

    expect(child.actor.stores.config.getDisplayName()).toBe('');
    // The roster row is the one every reader shows, so a title only the actor
    // knows about is a title nobody can see.
    expect(await displayedName(parent, name)).toBe('');
  });

  test('a rename wins on both sides, and a second rename wins again', async () => {
    const { child, parent, name } = await addedAgent({
      displayName: '', nameOrigin: 'auto',
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

describe('an agent hired with a name', () => {
  // The hire states the name, and it stands as hired: there is no titler to
  // replace a choice its parent made with one nobody asked for.
  test('keeps the name it was hired with', async () => {
    const { child, parent, name } = await addedAgent({
      name: 'auditor-a1b2c3', displayName: 'Auditor', nameOrigin: 'auto',
      roleId: 'auditor', mission: 'Audit the billing path.',
    });

    expect(child.actor.stores.config.getDisplayName()).toBe('Auditor');
    expect(await displayedName(parent, name)).toBe('Auditor');
  });
});
