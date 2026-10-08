import { workspaceDatabase } from '@kinu.run/test-utils';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
// A workspace opened without a LocalAgentSession still routes its model lanes (`kinu evolve` via `openWorkspaceCLI`).
// The lanes are the ones the MCTS engine reads: `explorer: rt.llm` and `judge: rt.judgeModel`.
import { scratchDir } from '../../test-utils/src/scratch';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LLM, LLMProviderConfig, ModelRouteResolution, ReasoningEffort } from '@kinu.run/core';
import { captureOperationProfile, runOperationProfile, operationProfileStream, currentOperationProfile,
  WORKSPACE_RUN_ID, profileCatalogDigest } from '@kinu.run/core';
import { openWorkspaceCLI } from '../src/open';
import { createCLIRuntime, type CLIRuntime, workspaceHome } from '../src/runtime';
import { staticModelPlane } from '../src/profile-authority';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** Every route a lane resolved, with the operation that issued each stream. */
function recordRoutes(rt: CLIRuntime) {
  const seen: ModelRouteResolution[] = [];
  const issuer: Array<string | null> = [];

  rt.setModelForRoute?.(resolution => ({
    async *stream() { issuer.push(currentOperationProfile(rt.actor)?.turnId ?? null); seen.push(resolution); yield 'streamed'; },
    complete: async () => 'stub answer',
  }));

  return { seen, issuer };
}

/** A workspace on disk as `kinu evolve` finds one; no session is ever built. */
async function workspace(storedModel?: string): Promise<{ db: Database; dbPath: string }> {
  const dir = scratchDir('sessionless');
  const dbPath = join(dir, 'agent.db');
  const db = workspaceDatabase(dbPath);
  const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM, agentName: 'jarvis' });
  // SOUL.md where the workspace keeps it, a real file of its own space.
  await writeText(workspaceHome(db), 'SOUL.md', '# jarvis\n\n## Mission\n\nRun the lab.');

  if (storedModel !== undefined) rt.actor.config.setModel(storedModel);

  return { db, dbPath };
}

/** Stubs the model a resolved route runs with, not the routing decision. */
function stubModels(rt: CLIRuntime): ModelRouteResolution[] {
  const seen: ModelRouteResolution[] = [];
  rt.setModelForRoute?.((resolution): LLM => ({
    async *stream() { yield ''; },
    complete: async () => {
      seen.push(resolution);

      return 'stub answer';
    },
  }));

  return seen;
}

describe('a local runtime opened without a session', () => {
  test('a later runtime operation resolves the revised profile authority', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
    const seen = stubModels(rt);
    await rt.llm.complete('before the authority change');
    rt.profiles?.refine({ plane: staticModelPlane() });
    await rt.llm.complete('after the authority change');

    expect(seen.map(route => route.model)).toEqual(['openai-compat/fake-model', 'local/static']);
  });

  test("the explorer lane reaches the model instead of refusing for want of a resolver", async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
    const seen = stubModels(rt);

    expect(await rt.llm.complete('propose one improvement')).toBe('stub answer');
    expect(seen.map((resolution) => resolution.source)).toEqual(['reflection']);
  });

  test('every fixed-tier lane resolves to the tier its route policy names', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
    const seen = stubModels(rt);

    expect(rt.judgeModel).toBeDefined();

    await rt.judgeModel?.complete('grade this');
    await rt.fastLlm?.complete('classify this');

    expect(seen.map((resolution) => [resolution.source, resolution.tier])).toEqual([
      ['judge', 'deep'],
      ['fast', 'fast'],
    ]);
  });

  test('the tier model is the workspace\'s own stored model, never a default of its own', async () => {
    // Spelled as `setModel` stores it: the writer normalises, so a pin reaches resolution in the registry's spelling.
    const { db, dbPath } = await workspace('openai-compat/my-model');
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });

    const profile = await rt.ensureProfile?.();

    // Spelled by the registry the routed-lane factory resolves through, as the durable row a session reads.
    expect(profile?.tier.model).toBe('openai-compat/my-model');
    expect(profile?.tiers.deep.model).toBe('openai-compat/my-model');
  });

  test('with nothing stored it falls to the endpoint the workspace was opened against', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });

    expect((await rt.ensureProfile?.())?.tier.model).toBe('openai-compat/fake-model');
  });

  test('an issued operation retains its profile while a later operation sees revised authority', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
    const pinned = await rt.ensureProfile?.();

    if (!pinned) throw new Error('runtime profile resolution is required');
    const operation = captureOperationProfile({ actor: rt.actor, profile: pinned, inputs: null, runId: 'turn-A', turnId: 'turn-A' });
    const hold = Promise.withResolvers<void>();

    const oldWork = runOperationProfile(operation, async () => {
      await hold.promise;

      return rt.llm.complete('detached operation A');
    });

    const seen = stubModels(rt);
    rt.profiles?.refine({ plane: staticModelPlane() });
    await rt.llm.complete('new operation B');
    hold.resolve();
    await oldWork;

    expect(seen.map(route => route.model)).toEqual(['local/static', 'openai-compat/fake-model']);
  });

  test('a lane stream issued under one operation retains its route when another operation consumes it', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
    let tierModel = 'openai-compat/fake-model';
    let effort: ReasoningEffort = 'high';
    rt.profiles?.refine({ envelope: () => {
      const catalog = { roles: {}, tiers: { default: { model: tierModel }, fast: { model: tierModel, reasoningEffort: effort } } };

      return { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog };
    } });
    const profileA = await rt.ensureProfile?.();

    if (!profileA) throw new Error('runtime profile resolution is required');
    const operationA = captureOperationProfile({ actor: rt.actor, profile: profileA, inputs: null, runId: 'turn-A', turnId: 'turn-A' });

    rt.profiles?.refine({ plane: staticModelPlane() });
    tierModel = 'local/static';
    effort = 'low';
    const profileB = await rt.ensureProfile?.();

    if (!profileB) throw new Error('runtime profile resolution is required');
    const operationB = captureOperationProfile({ actor: rt.actor, profile: profileB, inputs: null, runId: 'turn-B', turnId: 'turn-B' });

    const { seen, issuer } = recordRoutes(rt);

    const stream = runOperationProfile(operationA, () =>
      rt.llm.stream({ system: 's', messages: [{ role: 'user', content: 'issued under A' }] }));

    const drained: string[] = [];
    await runOperationProfile(operationB, async () => {
      for await (const delta of stream) drained.push(delta);
    });

    expect(drained).toEqual(['streamed']);
    expect(seen.map(route => route.model)).toEqual(['openai-compat/fake-model']);
    expect(seen[0]?.reasoningEffort).toBe('high');
    expect(issuer).toEqual(['turn-A']);
  });

  test('a lane stream issued with no operation resolves fresh authority under the workspace identity', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
    const profileA = await rt.ensureProfile?.();

    if (!profileA) throw new Error('runtime profile resolution is required');
    const operationA = captureOperationProfile({ actor: rt.actor, profile: profileA, inputs: null, runId: 'turn-A', turnId: 'turn-A' });

    rt.profiles?.refine({ plane: staticModelPlane() });

    const { seen, issuer } = recordRoutes(rt);

    // No ambient operation at issue time, so the stream must not pick up whoever consumes it.
    const stream = rt.llm.stream({ system: 's', messages: [{ role: 'user', content: 'unowned' }] });

    await runOperationProfile(operationA, async () => {
      for await (const _ of stream) void _;
    });

    expect(seen.map(route => route.model)).toEqual(['local/static']);
    expect(issuer).toEqual([WORKSPACE_RUN_ID]);
  });

  test('a delayed generator retains its issuing profile for every continuation and cleanup', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
    const profile = await rt.ensureProfile?.();

    if (!profile) throw new Error('runtime profile resolution is required');
    const operation = captureOperationProfile({ actor: rt.actor, profile, inputs: null, runId: 'A', turnId: 'A' });
    const seen = stubModels(rt);

    const events = operationProfileStream((async function* () {
      try {
        yield await rt.llm.complete('first A request');
        yield await rt.llm.complete('second A request');
      } finally {
        await rt.llm.complete('A cleanup');
      }
    })(), operation);

    rt.profiles?.refine({ plane: staticModelPlane() });
    await events.next();
    await rt.llm.complete('B between A continuations');
    await events.next();
    await events.return(undefined);

    expect(seen.map(route => route.model)).toEqual([
      'openai-compat/fake-model', 'local/static', 'openai-compat/fake-model', 'openai-compat/fake-model',
    ]);
  });

  test('revoking authority refuses later requests without mutating an issued request', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    rt.setModelForRoute?.(route => ({
      async *stream() { yield ''; },
      complete: async () => {
        started.resolve();
        await held.promise;

        return route.model;
      },
    }));
    const issued = rt.llm.complete('issued before revocation');
    await started.promise;
    rt.setProfileResolver?.(async () => { throw new Error('credential revoked'); });
    await expect(rt.llm.complete('issued after revocation')).rejects.toThrow('credential revoked');
    held.resolve();
    expect(await issued).toBe('openai-compat/fake-model');
  });
});

describe('the authority a session refines', () => {
  test('a refined plane answers the next resolution, and the listing cached under the old one is dropped', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });

    expect((await rt.profiles?.resolvePreTurn())?.tier.model).toBe('openai-compat/fake-model');

    // What a session with no provider registry installs: a refinement of the one resolver, never a second.
    rt.profiles?.refine({ plane: staticModelPlane() });

    expect((await rt.profiles?.resolvePreTurn())?.tier.model).toBe('local/static');
    expect(rt.profiles?.normalizeSpec(null)).toBe('local/static');
  });

  test('a catalog authority overrides the workspace bootstrap without touching the resolver', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
    const bootstrap = await rt.profiles?.envelope();

    if (!bootstrap) throw new Error('the runtime built no profile authority');

    rt.profiles?.refine({ envelope: () => ({ ...bootstrap, version: 7 }) });

    expect((await rt.profiles?.envelope())?.version).toBe(7);
    expect((await rt.profiles?.resolvePreTurn())?.catalogVersion).toBe(7);
  });
});
