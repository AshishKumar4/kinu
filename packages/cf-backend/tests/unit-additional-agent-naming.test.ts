/**
 * How an agent the owner ADDED gets its name, end to end through real actors.
 *
 * The owner adds an agent to a workspace and says nothing about it: no name, no
 * mission, no role. It inherits the workspace's mission, and it has no honest
 * title until the owner speaks to it — so the shared first-interaction title
 * policy (`identity/naming.ts`) names it from that first message, once.
 *
 * Both halves run as production code here: a real `SubordinateAgent` seeded
 * through the real `setSubordinateIdentity`, hanging off a real
 * `OrchestratorAgent` whose roster is the row every roster reader shows. The
 * facet itself is workerd-only, so what is substituted is model CONSTRUCTION
 * and nothing above it.
 */

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import {
  BUILTIN_PROFILE_CATALOG, profileCatalogDigest, resolveTurnProfile,
} from '@kinu.run/core';
import { hiredSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

const TINY_MODEL = 'fake-a/m1';

/** A profile whose `tiny` tier — where `MODEL_ROUTE_POLICY.fast` routes — is a
 *  scripted model, so the naming pass resolves through the production route. */
function namingProfile() {
  const catalog = {
    ...BUILTIN_PROFILE_CATALOG,
    tiers: {
      default: { model: 'fake-chat/m1' },
      tiny: { model: TINY_MODEL, reasoningEffort: 'low' as const },
      deep: { model: 'fake-deep/m1' },
    },
  };
  return resolveTurnProfile({
    envelope: {
      authority: { kind: 'account', accountId: 'acct-1' },
      version: 1,
      digest: profileCatalogDigest(catalog),
      catalog,
    },
    provider: { revision: 'rev-1', availableModels: ['fake-chat/m1', TINY_MODEL, 'fake-deep/m1'] },
    roleId: 'general',
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  });
}

function titleModel(title: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ title }) }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

const WORKSPACE_MISSION = 'Keep the release train moving.';

/**
 * A parent workspace with one agent added to it, and a count of how many times
 * the naming model was asked for a title.
 *
 * The roster row is written through the production store, which is what
 * `provision` writes on the create path; only the facet birth it wraps needs
 * workerd. `suggested` is the assertion with teeth for "once": a policy that
 * re-fires spends another model call, and that is visible here even when the
 * stored title happens to look right.
 */
async function addedAgent(seed: {
  name?: string;
  displayName: string;
  nameOrigin: 'user' | 'auto';
  role: string;
  roleId?: string;
  mission?: string;
  title?: string;
}) {
  const parent = orchestratorHarness();
  const name = seed.name ?? 'quiet-harbor-1a4e20';
  const identity: Parameters<typeof hiredSubordinateHarness>[1] = {
    name,
    displayName: seed.displayName,
    nameOrigin: seed.nameOrigin,
    role: seed.role,
    mission: seed.mission ?? WORKSPACE_MISSION,
  };
  if (seed.roleId) identity.roleId = seed.roleId;
  const child = await hiredSubordinateHarness(parent, identity);
  parent.agent.harnessRoster().create({
    name,
    displayName: seed.displayName,
    role: seed.role,
    createdBy: 'user',
    status: 'idle',
    currentTask: null,
    createdAt: 1,
    dismissedAt: null,
  });
  const suggested: string[] = [];
  const model = titleModel(seed.title ?? 'Release Train');
  Object.assign(child.agent, {
    routingProfile: async () => namingProfile(),
    ownedModelServices: {
      resolveModelWithEffort: (spec: string | null | undefined) => {
        suggested.push(String(spec));
        return { model, providerOptions: undefined };
      },
    },
  });
  return { parent, child, name, suggested };
}

describe('an agent the owner added without naming it', () => {
  test('is born with no title, the general role and the workspace mission', async () => {
    const { child } = await addedAgent({
      displayName: '', nameOrigin: 'auto', role: 'general', roleId: 'general',
    });

    expect(child.agent.observeNaming()).toEqual({ displayName: '', nameOrigin: 'auto' });
    // It knows what the workspace is for, which is what it inherited.
    const soul = await child.agent.observeIdentitySoul();
    expect(soul).toContain(WORKSPACE_MISSION);
    expect(soul).toContain('Role: general');
    // With no title, it calls itself by the name it is genuinely addressed by
    // rather than opening its own identity with a blank.
    expect(soul).toContain('quiet-harbor-1a4e20');
  });

  test('is named by the first thing its owner says to it, once, on both sides', async () => {
    const { parent, child, name, suggested } = await addedAgent({
      displayName: '', nameOrigin: 'auto', role: 'general', roleId: 'general',
      title: 'Callback Audit',
    });

    await child.agent.titleFromFirstMessage('Audit the OAuth callback flow');

    expect(child.agent.observeNaming()).toEqual({
      displayName: 'Callback Audit', nameOrigin: 'auto',
    });
    // The roster row is the one every reader shows, so a title only the facet
    // knows about is a title nobody can see.
    expect(parent.agent.harnessRoster().requireActive(name).displayName).toBe('Callback Audit');
    expect(suggested).toEqual([TINY_MODEL]);

    // A second owner message is not a second naming pass: persisting the title
    // left `name_origin` set over a name that is no longer a placeholder, so
    // the shared policy stops matching.
    await child.agent.titleFromFirstMessage('Now check the refresh path');
    expect(child.agent.observeNaming().displayName).toBe('Callback Audit');
    expect(suggested).toEqual([TINY_MODEL]);
  });

  test('keeps the name its owner typed, and never asks a model for another', async () => {
    const { parent, child, name, suggested } = await addedAgent({
      displayName: '', nameOrigin: 'auto', role: 'general', roleId: 'general',
    });

    await parent.agent.renameSubordinateAgent(name, 'Jarvis');

    expect(child.agent.observeNaming()).toEqual({ displayName: 'Jarvis', nameOrigin: 'user' });
    expect(parent.agent.harnessRoster().requireActive(name).displayName).toBe('Jarvis');

    await child.agent.titleFromFirstMessage('Audit the OAuth callback flow');

    expect(child.agent.observeNaming()).toEqual({ displayName: 'Jarvis', nameOrigin: 'user' });
    expect(parent.agent.harnessRoster().requireActive(name).displayName).toBe('Jarvis');
    // Not merely "the title survived": the model was never asked, so the
    // refusal happened before the spend rather than after it.
    expect(suggested).toEqual([]);
  });

  test('a rename after an auto title still wins, and closes the door behind it', async () => {
    const { parent, child, name, suggested } = await addedAgent({
      displayName: '', nameOrigin: 'auto', role: 'general', roleId: 'general',
      title: 'Callback Audit',
    });

    await child.agent.titleFromFirstMessage('Audit the OAuth callback flow');
    await parent.agent.renameSubordinateAgent(name, 'Jarvis');
    await child.agent.titleFromFirstMessage('Something else entirely');

    expect(child.agent.observeNaming()).toEqual({ displayName: 'Jarvis', nameOrigin: 'user' });
    expect(parent.agent.harnessRoster().requireActive(name).displayName).toBe('Jarvis');
    expect(suggested).toEqual([TINY_MODEL]);
  });
});

describe('an agent the model hired', () => {
  // The hire rung is unchanged: it states a role, and the name derived from
  // that role is a real name. Retitling it would replace a choice its parent
  // made with one nobody asked for.
  test('keeps the name derived from the role it was hired for', async () => {
    const { parent, child, name, suggested } = await addedAgent({
      name: 'auditor-a1b2c3', displayName: 'Auditor', nameOrigin: 'auto',
      role: 'auditor', roleId: 'auditor', mission: 'Audit the billing path.',
    });

    await child.agent.titleFromFirstMessage('What did you find?');

    expect(child.agent.observeNaming()).toEqual({ displayName: 'Auditor', nameOrigin: 'auto' });
    expect(parent.agent.harnessRoster().requireActive(name).displayName).toBe('Auditor');
    expect(suggested).toEqual([]);
  });
});
