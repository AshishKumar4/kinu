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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LLM, LLMProviderConfig, ModelRouteResolution } from '@kinu.run/core';
import { createAgentConfigStore, initAgentConfigTable } from '@kinu.run/core';
import { createInlineWorkspace } from '@kinu.run/core/identity';
import { openWorkspaceCLI } from '../src/open';
import { makeSql, type CLIRuntime } from '../src/runtime';
import { STATIC_MODEL_SPEC, staticModelPlane } from '../src/profile-authority';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A workspace on disk, exactly as `kinu evolve` finds one: an identity row, a
 *  SOUL, and whatever model the operator stored. No session is ever built. */
async function workspace(storedModel?: string): Promise<{ db: Database; dbPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'kinu-sessionless-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'agent.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE workspace_identity (
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );`);
  db.run('INSERT INTO workspace_identity (id, name) VALUES (?, ?)', ['ws-1', 'jarvis']);
  const inline = createInlineWorkspace(db);
  await inline.vfs.writeFile('SOUL.md', '# jarvis\n\n## Mission\n\nRun the lab.');
  if (storedModel !== undefined) {
    initAgentConfigTable((ddl) => db.exec(ddl));
    createAgentConfigStore(makeSql(db)).setModel(storedModel);
  }
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
  test("the explorer lane reaches the model instead of refusing for want of a resolver", async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, hostRoot: null });
    const seen = stubModels(rt);

    // core mcts/engine.ts passes `explorer: rt.llm`; this is the exact call
    // that threw for every `kinu evolve` branch.
    expect(await rt.llm.complete('propose one improvement')).toBe('stub answer');
    expect(seen.map((resolution) => resolution.source)).toEqual(['reflection']);
  });

  test('every fixed-tier lane resolves to the tier its route policy names', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, hostRoot: null });
    const seen = stubModels(rt);

    // A lane is derived from the live turn profile, so a runtime with none
    // yet reports its lanes unset — routing has nothing to route against.
    expect(rt.judgeModel).toBeUndefined();

    // Resolving one puts the runtime into a routed state on its own, which is
    // the whole capability a session-less surface was missing.
    const profile = await rt.ensureProfile?.();
    expect(profile?.tier.id).toBe('default');

    await rt.judgeModel?.complete('grade this');
    await rt.fastLlm?.complete('classify this');
    await rt.advisorLlm?.complete('advise on this');

    expect(seen.map((resolution) => [resolution.source, resolution.tier])).toEqual([
      ['judge', 'deep'],
      ['fast', 'tiny'],
      ['advisor', 'slow'],
    ]);
  });

  test('the tier model is the workspace\'s own stored model, never a default of its own', async () => {
    const { db, dbPath } = await workspace('my-model');
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, hostRoot: null });

    const profile = await rt.ensureProfile?.();

    // `agent_config.model` spelled in full by the same registry the routed-lane
    // factory resolves through — the durable row a session reads, not a
    // constant chosen here.
    expect(profile?.tier.model).toBe('openai-compat/my-model');
    expect(profile?.tiers.deep.model).toBe('openai-compat/my-model');
  });

  test('with nothing stored it falls to the endpoint the workspace was opened against', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, hostRoot: null });

    expect((await rt.ensureProfile?.())?.tier.model).toBe('openai-compat/fake-model');
  });

  test('a turn profile already installed is never displaced by a lane resolving one', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, hostRoot: null });
    const pinned = await rt.ensureProfile?.();

    expect(await rt.ensureProfile?.()).toBe(pinned);
  });
});

describe('the authority a session refines', () => {
  test('a refined plane answers the next resolution, and the listing cached under the old one is dropped', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, hostRoot: null });

    expect((await rt.profiles?.resolvePreTurn())?.tier.model).toBe('openai-compat/fake-model');

    // What a session with no provider registry installs. It refines the ONE
    // authority the runtime built; nothing installs a second resolver.
    rt.profiles?.refine({ plane: staticModelPlane() });

    expect((await rt.profiles?.resolvePreTurn())?.tier.model).toBe(STATIC_MODEL_SPEC);
    expect(rt.profiles?.normalizeSpec(null)).toBe(STATIC_MODEL_SPEC);
  });

  test('a catalog authority overrides the workspace bootstrap without touching the resolver', async () => {
    const { db, dbPath } = await workspace();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, hostRoot: null });
    const bootstrap = await rt.profiles?.envelope();
    if (!bootstrap) throw new Error('the runtime built no profile authority');

    rt.profiles?.refine({ envelope: () => ({ ...bootstrap, version: 7 }) });

    expect((await rt.profiles?.envelope())?.version).toBe(7);
    expect((await rt.profiles?.resolvePreTurn())?.catalogVersion).toBe(7);
  });
});
