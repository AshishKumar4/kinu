/**
 * A turn assembled in an agent's isolate reads its models from the bundle its workspace materialized. Read for the tier
 * the turn runs on, the serving model is given its own window and media; a model the bundle was not read for is
 * refused, never given another model's window or no media at all.
 */
import { expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { modelWindow } from '../src/context-window';
import { assembleActorTurn, materializeTurnSources, turnSourcesFromBundle, type TurnAssemblySources } from '../src/orchestrator/turn-assembly';
import { profileCatalogDigest } from '../src/profiles';
import { hostedSeatsOver } from './helpers-actor-host';

const SMALL = 'fake/small';

const LARGE = 'fake/large';

/** Each model's own catalog entry, as the workspace's catalog answers it. */
const MODELS = {
  [SMALL]: { window: modelWindow({ contextWindow: 32_000, modelOutputLimit: 4_000 }), media: ['image'] },
  [LARGE]: { window: modelWindow({ contextWindow: 400_000, modelOutputLimit: 32_000 }), media: ['image', 'pdf'] },
} as const;

const CATALOG = {
  roles: { tester: { description: 'Runs one turn under test.', instructions: 'Answer the task.', tier: 'default', preset: 'ideate', spawns: '*' } },
  tiers: { default: { model: SMALL }, deep: { model: LARGE } },
} as const;

/** The workspace's sources for one actor: its own stores, and a catalog that knows both models. */
async function workspaceSources(): Promise<TurnAssemblySources> {
  const { rt, testSql } = createTestRuntime();
  // Assembling a turn names its model and never calls it.
  const { sources } = await hostedSeatsOver({ rt, db: testSql.db, model: (spec) => spec }).seat('bundled', 'agent');
  const known = (spec: string) => MODELS[spec === LARGE ? LARGE : SMALL];

  return {
    ...sources,
    profileInputs: async () => ({
      envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(CATALOG), catalog: CATALOG },
      provider: { revision: 'bundle-test', availableModels: [SMALL, LARGE] },
    }),
    models: {
      ...sources.models,
      catalog: { window: (spec) => known(spec ?? SMALL).window, windowFor: async (spec) => known(spec).window, warm: async () => {}, acceptedMedia: (spec) => new Set(known(spec ?? SMALL).media) },
    },
    toolset: () => ({}),
    externalTools: async () => ({}),
    wiredToolNames: () => [],
    codemodeCapabilities: () => [],
  };
}

test('a turn on the tier its bundle was read for is served on that model with its own window and media', async () => {
  const workspace = await workspaceSources();
  const bundle = await materializeTurnSources(workspace, { userText: '', workMode: 'build', explicitTier: 'deep' });
  const isolate = { ...turnSourcesFromBundle(bundle, workspace), toolset: () => ({}), externalTools: async () => ({}) };
  const { window, execution } = await assembleActorTurn(isolate, { userText: '', workMode: 'build', explicitTier: 'deep' });

  expect({ model: execution.chat.modelSpec, window, media: [...execution.chat.attachments?.accepts ?? []] })
    .toEqual({ model: LARGE, window: MODELS[LARGE].window, media: [...MODELS[LARGE].media] });
});

test('a turn on a tier its bundle was not read for is refused, not given another model\'s window', async () => {
  const workspace = await workspaceSources();
  const bundle = await materializeTurnSources(workspace, { userText: '', workMode: 'build' });
  const isolate = { ...turnSourcesFromBundle(bundle, workspace), toolset: () => ({}), externalTools: async () => ({}) };

  await expect(assembleActorTurn(isolate, { userText: '', workMode: 'build', explicitTier: 'deep' })).rejects.toMatchObject({ code: 'missing' });
});
