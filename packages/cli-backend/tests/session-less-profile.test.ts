// A local workspace opened WITHOUT a LocalAgentSession still routes its model
// lanes.
//
// The defect this pins: `setProfileResolver` had exactly one caller, the
// LocalAgentSession constructor, so every surface that opens a workspace and
// drives it directly — `kinu evolve` through `openWorkspaceCLI`, a fixture, a
// scheduled one-shot — got a runtime whose judge, explorer, fast and advisor
// lanes threw `this runtime has no profile resolver`. `kinu evolve` spent a
// real search against that throw and printed
// `! [1/1] branch ... this runtime has no profile resolver` followed by
// `Did not converge — best score: 0.000`.
//
// The lanes exercised here are the ones the MCTS engine actually reads:
// `explorer: rt.llm` and `judge: rt.judgeModel` (core mcts/engine.ts:306-307).
import { scratchDir } from '../../test-utils/src/scratch';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LLM, LLMProviderConfig, ModelRouteResolution } from '@kinu.run/core';
import { captureOperationProfile, runOperationProfile, operationProfileStream, currentOperationProfile,
  WORKSPACE_RUN_ID } from '@kinu.run/core';
import { openWorkspaceCLI } from '../src/open';
import { createCLIRuntime, type CLIRuntime } from '../src/runtime';
import { STATIC_MODEL_SPEC, staticModelPlane } from '../src/profile-authority';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** A workspace on disk, exactly as `kinu evolve` finds one: an identity row, a
 *  SOUL, and whatever model the operator stored. No session is ever built. */
async function workspace(storedModel?: string): Promise<{ db: Database; dbPath: string }> {
  const dir = scratchDir('sessionless');
  const dbPath = join(dir, 'agent.db');
  const db = new Database(dbPath);
  const rt = createCLIRuntime(db, { dbPath, llm: DUMMY_LLM, agentName: 'jarvis' });
  await (rt.agentStateVfs ?? rt.storage.vfs).writeFile('SOUL.md', '# jarvis\n\n## Mission\n\nRun the lab.');

  if (storedModel !== undefined) rt.actor.config.setModel(storedModel);

  return { db, dbPath };
}

/** Replace what a resolved route RUNS with, so no lane reaches a provider.
 *  The resolver under test is untouched — this stubs the model, not the
 *  routing decision. */
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
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });
    const seen = stubModels(rt);
    await rt.llm.complete('before the authority change');
    rt.profiles?.refine({ plane: staticModelPlane() });
    await rt.llm.complete('after the authority change');

    expect(seen.map(route => route.model)).toEqual(['openai-compat/fake-model', STATIC_MODEL_SPEC]);
  });

  test("the explorer lane reaches the model instead of refusing for want of a resolver", async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });
    const seen = stubModels(rt);

    // core mcts/engine.ts passes `explorer: rt.llm`; this is the exact call
    // that threw for every `kinu evolve` branch.
    expect(await rt.llm.complete('propose one improvement')).toBe('stub answer');
    expect(seen.map((resolution) => resolution.source)).toEqual(['reflection']);
  });

  test('every fixed-tier lane resolves to the tier its route policy names', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });
    const seen = stubModels(rt);

    expect(rt.judgeModel).toBeDefined();

    await rt.judgeModel?.complete('grade this');
    await rt.fastLlm?.complete('classify this');
    await rt.advisorLlm?.complete('advise on this');

    expect(seen.map((resolution) => [resolution.source, resolution.tier])).toEqual([
      ['judge', 'deep'],
      ['fast', 'fast'],
      ['advisor', 'deep'],
    ]);
  });

  test('the tier model is the workspace\'s own stored model, never a default of its own', async () => {
    const { db, dbPath } = await workspace('my-model');
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });

    const profile = await rt.ensureProfile?.();

    // `actor_config.model` spelled in full by the same registry the routed-lane
    // factory resolves through — the durable row a session reads, not a
    // constant chosen here.
    expect(profile?.tier.model).toBe('openai-compat/my-model');
    expect(profile?.tiers.deep.model).toBe('openai-compat/my-model');
  });

  test('with nothing stored it falls to the endpoint the workspace was opened against', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });

    expect((await rt.ensureProfile?.())?.tier.model).toBe('openai-compat/fake-model');
  });

  test('an issued operation retains its profile while a later operation sees revised authority', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });
    const pinned = await rt.ensureProfile?.();

    if (!pinned) throw new Error('runtime profile resolution is required');
    const operation = captureOperationProfile({ actor: rt.actor, profile: pinned, inputs: null, runId: 'turn-A', turnId: 'turn-A' });
    const hold = Promise.withResolvers<void>();

    const oldWork = runOperationProfile(operation, async () => {
      await hold.promise;
      expect(await rt.ensureProfile?.()).toBe(pinned);

      return rt.llm.complete('detached operation A');
    });

    const seen = stubModels(rt);
    rt.profiles?.refine({ plane: staticModelPlane() });
    await rt.llm.complete('new operation B');
    hold.resolve();
    await oldWork;

    expect(seen.map(route => route.model)).toEqual([STATIC_MODEL_SPEC, 'openai-compat/fake-model']);
  });

  test('a lane stream issued under one operation retains its route when another operation consumes it', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });
    const profileA = await rt.ensureProfile?.();

    if (!profileA) throw new Error('runtime profile resolution is required');
    const operationA = captureOperationProfile({ actor: rt.actor, profile: profileA, inputs: null, runId: 'turn-A', turnId: 'turn-A' });

    rt.profiles?.refine({ plane: staticModelPlane() });
    const profileB = await rt.ensureProfile?.();

    if (!profileB) throw new Error('runtime profile resolution is required');
    const operationB = captureOperationProfile({ actor: rt.actor, profile: profileB, inputs: null, runId: 'turn-B', turnId: 'turn-B' });

    const seen: ModelRouteResolution[] = [];
    const issuer: Array<string | null> = [];
    rt.setModelForRoute?.(resolution => ({
      async *stream() { issuer.push(currentOperationProfile(rt.actor)?.turnId ?? null); seen.push(resolution); yield 'streamed'; },
      complete: async () => 'stub answer',
    }));

    const stream = runOperationProfile(operationA, () =>
      rt.llm.stream({ system: 's', messages: [{ role: 'user', content: 'issued under A' }] }));

    const drained: string[] = [];
    await runOperationProfile(operationB, async () => {
      for await (const delta of stream) drained.push(delta);
    });

    expect(drained).toEqual(['streamed']);
    expect(seen.map(route => route.model)).toEqual(['openai-compat/fake-model']);
    expect(seen[0]?.reasoningEffort).toBe(profileA.tier.reasoningEffort);
    expect(issuer).toEqual(['turn-A']);
  });

  test('a lane stream issued with no operation resolves fresh authority under the workspace identity', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });
    const profileA = await rt.ensureProfile?.();

    if (!profileA) throw new Error('runtime profile resolution is required');
    const operationA = captureOperationProfile({ actor: rt.actor, profile: profileA, inputs: null, runId: 'turn-A', turnId: 'turn-A' });

    rt.profiles?.refine({ plane: staticModelPlane() });

    const seen: ModelRouteResolution[] = [];
    const issuer: Array<string | null> = [];
    rt.setModelForRoute?.(resolution => ({
      async *stream() { issuer.push(currentOperationProfile(rt.actor)?.turnId ?? null); seen.push(resolution); yield 'streamed'; },
      complete: async () => 'stub answer',
    }));

    // No ambient operation at issue time: nothing owns this stream yet, so it
    // must not pick up whoever happens to consume it.
    const stream = rt.llm.stream({ system: 's', messages: [{ role: 'user', content: 'unowned' }] });

    await runOperationProfile(operationA, async () => {
      for await (const _ of stream) void _;
    });

    expect(seen.map(route => route.model)).toEqual([STATIC_MODEL_SPEC]);
    expect(issuer).toEqual([WORKSPACE_RUN_ID]);
  });

  test('a delayed generator retains its issuing profile for every continuation and cleanup', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });
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
      'openai-compat/fake-model', STATIC_MODEL_SPEC, 'openai-compat/fake-model', 'openai-compat/fake-model',
    ]);
  });

  test('revoking authority refuses later requests without mutating an issued request', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });
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
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });

    expect((await rt.profiles?.resolvePreTurn())?.tier.model).toBe('openai-compat/fake-model');

    // What a session with no provider registry installs. It refines the ONE
    // authority the runtime built; nothing installs a second resolver.
    rt.profiles?.refine({ plane: staticModelPlane() });

    expect((await rt.profiles?.resolvePreTurn())?.tier.model).toBe(STATIC_MODEL_SPEC);
    expect(rt.profiles?.normalizeSpec(null)).toBe(STATIC_MODEL_SPEC);
  });

  test('a catalog authority overrides the workspace bootstrap without touching the resolver', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });
    const bootstrap = await rt.profiles?.envelope();

    if (!bootstrap) throw new Error('the runtime built no profile authority');

    rt.profiles?.refine({ envelope: () => ({ ...bootstrap, version: 7 }) });

    expect((await rt.profiles?.envelope())?.version).toBe(7);
    expect((await rt.profiles?.resolvePreTurn())?.catalogVersion).toBe(7);
  });
});
