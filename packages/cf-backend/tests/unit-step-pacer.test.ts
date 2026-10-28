/**
 * A turn's steps run under a grant the workspace holds open into the agent's isolate (platform catalog
 * `do.facet.cpu_ms`): one grant serves the steps while it has budget, a cut of the turn revokes it, and its turn's end,
 * a stop or a rest let it go.
 */
import { expect, test } from 'bun:test';
import { PLATFORM_LIMITS, profileCatalogDigest, resolveTurnProfile, type HarnessMode, type ProfileCatalog } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import { StepPacer } from '../src/agent-facet/step-pacer';
import type { TurnBound } from '../src/agent-facet/agent-turn';
import { gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { delayNextToolAnswer, loseNextInterrupt } from './helpers/agent-facets';
import { chatCompletion, openingOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const BOUND: TurnBound = { turnId: 'turn-1', runId: 'run-1', epoch: 7 };

/** Every settlement already owed has run. */
const drained = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

const CATALOG = { roles: { reader: { description: 'Read', instructions: 'Read.', tier: 'default', preset: 'ideate', allowedTools: [] } },
  tiers: { default: { model: 'test-model' } } } satisfies ProfileCatalog;

/** A turn's resolved profile, as the step that binds it hands it on. */
const PROFILE = resolveTurnProfile({
  envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(CATALOG), catalog: CATALOG },
  provider: { revision: 'pacer-test', availableModels: ['test-model'] },
  roleId: 'reader', workMode: 'build', availableTools: [], activeSkills: [],
});

/** The workspace's `harness.mode`, as each grant carries it. */
interface WorkspaceHarness {
  mode: HarnessMode;
}

/** The workspace's side: each pace grants through the pacer, as its call into the isolate does, and stays open until the
 *  grant is let go; `cut` rejects every open one, as a Stop's fence does. */
function grantingWorkspace(pacer: StepPacer) {
  const paces: TurnBound[] = [];
  const answered: string[] = [];
  let cut = Promise.withResolvers<never>();
  let refusing = false;
  const harness: WorkspaceHarness = { mode: 'native' };

  return {
    paces,
    answered,
    harness,
    cut: () => { cut.reject(new KinuError('cancelled', 'stale_epoch: the turn was stopped')); cut = Promise.withResolvers<never>(); refusing = true; },
    port: {
      paceStep: async (bound: TurnBound) => {
        paces.push(bound);

        if (refusing) throw new KinuError('cancelled', 'stale_epoch: the turn was stopped');
        const granted = pacer.grant(bound.turnId, null, harness.mode).then(() => { answered.push(bound.turnId); });

        await Promise.race([granted, cut.promise]);
      },
    },
  };
}

test("a turn's steps share one grant, which its end lets go", async () => {
  const pacer = new StepPacer();
  const ws = grantingWorkspace(pacer);
  const signal = new AbortController().signal;

  for (let step = 0; step < 4; step++) (await pacer.pace(ws.port, BOUND, signal, null)).ended();

  expect(ws.paces).toHaveLength(1);
  expect(ws.answered).toEqual([]);

  pacer.release(BOUND.turnId);
  await drained();
  expect(ws.answered).toEqual([BOUND.turnId]);
});

test('a cut revokes the held grant: the next step asks, and is refused', async () => {
  const pacer = new StepPacer();
  const ws = grantingWorkspace(pacer);
  const signal = new AbortController().signal;

  await pacer.pace(ws.port, BOUND, signal, null);
  ws.cut();
  await drained();

  // Refused as the fence refuses it: the turn was stopped.
  await expect(pacer.pace(ws.port, BOUND, signal, null)).rejects.toMatchObject({ code: 'cancelled' });
  expect(ws.paces).toHaveLength(2);
});

test('a step that binds the profile, a new execution and a spent budget each ask again', async () => {
  let now = 0;
  const pacer = new StepPacer(() => now);
  const ws = grantingWorkspace(pacer);
  const signal = new AbortController().signal;

  await pacer.pace(ws.port, BOUND, signal, null);
  await pacer.pace(ws.port, BOUND, signal, PROFILE);
  await pacer.pace(ws.port, { ...BOUND, epoch: 8 }, signal, null);
  now = PLATFORM_LIMITS['do.facet.cpu_ms'].value / 2;
  await pacer.pace(ws.port, { ...BOUND, epoch: 8 }, signal, null);
  await drained();

  expect(ws.paces.map((bound) => bound.epoch)).toEqual([7, 7, 8, 8]);
  // Each newer grant let the one before it go.
  expect(ws.answered).toHaveLength(3);
});

// FEAT-2 step 1: an agent's isolate reads the workspace's `harness.mode` off the grant its step runs under, so a change
// reaches its steps at its next grant: a renewal, a new execution, or a step that binds the profile.
test("each step reads the workspace's harness mode as the grant it runs under carried it", async () => {
  let now = 0;
  const pacer = new StepPacer(() => now);
  const ws = grantingWorkspace(pacer);
  const signal = new AbortController().signal;
  const read: HarnessMode[] = [];

  ws.harness.mode = 'auto';
  read.push((await pacer.pace(ws.port, BOUND, signal, null)).harnessMode);
  ws.harness.mode = 'pi';
  read.push((await pacer.pace(ws.port, BOUND, signal, null)).harnessMode);
  now = PLATFORM_LIMITS['do.facet.cpu_ms'].value / 2;
  read.push((await pacer.pace(ws.port, BOUND, signal, null)).harnessMode);
  await drained();

  // The held grant's, then the renewed one's.
  expect(read).toEqual(['auto', 'auto', 'pi']);
});

test('a stopped turn and a resting agent hold no grant', async () => {
  const pacer = new StepPacer();
  const ws = grantingWorkspace(pacer);
  const stop = new AbortController();

  await pacer.pace(ws.port, BOUND, stop.signal, null);
  stop.abort(new Error('stopped'));
  await pacer.pace(ws.port, { ...BOUND, turnId: 'turn-2' }, new AbortController().signal, null);
  pacer.releaseAll();
  await drained();

  expect(ws.answered).toEqual(['turn-1', 'turn-2']);
});

test("a Stop whose push to the isolate is lost, between a tool's answer and the next step, ends the turn before that step asks its model", async () => {
  const ASK = 'Write the notes.';
  let asked = 0;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (!openingOf(run).includes(ASK)) return chatCompletion(run, 'Done.');
    asked += 1;

    return toolCallCompletion(run, { tool: 'file', args: { op: 'write', path: `/home/main/note-${String(asked)}.md`, content: 'n' } }, `call_${String(asked)}`);
  }));

  const { storageKey } = workspace.agent.agentOf(workspaceMainActor(workspace.db).actorId);
  const answer = delayNextToolAnswer(storageKey);
  const sent = workspace.agent.send(ASK, crypto.randomUUID(), []);

  await answer.reached;
  // The workspace cuts the turn; its push to the isolate never arrives, which the Stop's caller hears.
  loseNextInterrupt(storageKey);
  await expect(workspace.agent.cancelCurrentWork()).rejects.toThrow('the Stop was lost on its way to the agent');
  answer.release();
  await sent;
  await workspace.agent.harnessAgentsIdle();

  // Its first step asked; the step after the tool's answer found its grant revoked, asked again, and was refused.
  expect(asked).toBe(1);
});
