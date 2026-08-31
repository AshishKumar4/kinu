/**
 * A legacy workspace is titled by the frame that OPENED it, never by its
 * activation.
 *
 * Workspaces created before mission-derived titling still show their raw slug.
 * Healing one reads the owner registry, reads SOUL.md, and asks a model for a
 * name — and that whole chain used to be SPAWNED from
 * `OrchestratorAgent.onStart`, inside `blockConcurrencyWhile`, on every cold
 * start of every claimed workspace whether or not anybody was looking at the
 * title. Detaching took it out of the gate's WAIT, not off the init path: the
 * promise ran against an activation whose gate was still open, and an eviction
 * cancels a floating promise with its rejection swallowed by the runtime.
 *
 * Both halves are asserted, because either one alone is satisfiable by doing
 * nothing at all: the activation must reach no model, AND the workspace-open
 * `@callable` the web client calls on mount (`getWorkspaceSnapshot`, from
 * `hooks/use-kinu.ts`'s `loadAllData`) must produce the title.
 *
 * `scripts/do-init-gate.ts` holds the same invariant from the source side, by
 * REACH rather than by behaviour: a call named in its pinned `MODEL_SINKS` may
 * not appear inside a governed `onStart`, including inside a function
 * expression the hook spawns there.
 */

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { workspaceTitleFromMission, writeSoul } from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import {
  orchestratorHarness, reactivateOrchestratorHarness,
  type ActorHarness, type HarnessOrchestratorAgent, type RecordedUserPlaneCalls,
} from './helpers/actor-harness';

/** The spend source the naming pass files itself under, and routes as: one
 *  `'fast'` literal feeds both in `ActorAgent.suggestTitle`. Recorded rather
 *  than assumed, because a titling lane that ran under any other source would
 *  be spending against the wrong budget. */
const NAMING_SOURCE = 'fast';

/** The spec the substituted route reports back, so the operation and spend rows
 *  the pass writes name a model rather than nothing. Which spec the REAL route
 *  resolves for `fast` is pinned in unit-ensemble-operations.test.ts; this suite
 *  is about WHERE the pass runs from. */
const NAMING_SPEC = 'fake-a/m1';

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

const MISSION = 'Find why the SAVE20 coupon 500s at checkout and fix it.';
const LEGACY_SOUL = ['# workspace', '', '## Mission', '', MISSION].join('\n');
const GENERATED_TITLE = 'Coupon Fix';

/** The title that lands before any model is asked, from the ONE production
 *  derivation rather than a hand-copied string — a policy change there must
 *  show up here as a decision, not as a mystery diff. */
const PROVISIONAL_TITLE = workspaceTitleFromMission(MISSION);

/** A naming call held open, for the one claim a settled lane cannot make:
 *  `reached` fires when the pass has asked for its model, and it does not
 *  return until `release` resolves — a slow provider, without a clock. */
interface ParkedNaming {
  readonly reached: () => void;
  readonly release: Promise<void>;
}

/**
 * A legacy workspace exactly as a cold activation finds one: owner claim,
 * capability token and SOUL.md all durable, the shown title still the raw slug,
 * and a scripted naming model armed BEFORE `onStart` runs.
 *
 * Two activations, not one, and that is the point: the seeding harness writes
 * SOUL.md, and the reactivation is a fresh instance over the storage that
 * survived — which is what `onStart` actually runs against in production. A
 * suite that wrote the soul after activating would have hidden the defect, since
 * the spawned lane would have found no mission to title from.
 *
 * `asked` is the assertion with teeth throughout: a lane that runs when it
 * should not, or twice, spends another model call, and that is visible even when
 * the resulting title happens to look right.
 */
async function legacyWorkspace(park?: ParkedNaming): Promise<{
  harness: ActorHarness<HarnessOrchestratorAgent>;
  userPlane: RecordedUserPlaneCalls;
  asked: string[];
}> {
  const seeded = orchestratorHarness();
  await writeSoul(seeded.agent.observeRuntime().storage.vfs, sqlOver(seeded.db), LEGACY_SOUL);

  const userPlane: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [] };
  const asked: string[] = [];
  const harness = await reactivateOrchestratorHarness(seeded.db, userPlane, {
    // Armed before the activation, because the activation is what is on trial:
    // a model seam attached afterwards could not answer whether `onStart`
    // reached it. `modelForSource` is the narrowest seam that substitutes model
    // CONSTRUCTION and nothing above it: the operation framing, the prompt pair,
    // the parse and the spend report inside `suggestTitle` all still run, as
    // does every other plane the mount payload reads.
    beforeStart: (agent) => {
      Object.assign(agent, {
        modelForSource: async (source: string) => {
          asked.push(source);
          // Parked HERE rather than in the model: `suggestTitle` awaits this
          // seam, so a pass held at it is a lane in flight that has not
          // returned — which is what a slow provider looks like from outside.
          park?.reached();
          if (park) await park.release;
          return {
            model: titleModel(GENERATED_TITLE), spec: NAMING_SPEC, providerOptions: undefined,
          };
        },
      });
    },
  });
  return { harness, userPlane, asked };
}

describe('a legacy workspace still showing its slug', () => {
  test('is titled by nothing on activation — the init gate reaches no model', async () => {
    const { harness, userPlane, asked } = await legacyWorkspace();

    // Everything the activation detached, joined: the wake reconcile, the
    // event-delivery reconcile, the fork-journal reconcile and the facet
    // reclaim. If the titling chain were still spawned from `onStart`, this is
    // exactly where it would land — the old code registered it in the same set.
    await harness.agent.harnessSettleBackgroundTasks();

    expect(asked).toEqual([]);
    expect(userPlane.titles).toEqual([]);
  });

  test('is titled by the mount call, from SOUL.md, under the fast source', async () => {
    const { harness, userPlane, asked } = await legacyWorkspace();

    // The mount round trip, exactly as `loadAllData` makes it.
    await harness.agent.getWorkspaceSnapshot();
    // Detached from that frame rather than awaited by it, so the payload never
    // waits on a model call; a suite that wants the outcome joins it here.
    await harness.agent.harnessSettleBackgroundTasks();

    // The deterministic title is committed FIRST, so a dead naming model cannot
    // leave the raw slug showing, and the generated one then replaces it.
    expect(userPlane.titles).toEqual([PROVISIONAL_TITLE, GENERATED_TITLE]);
    expect(asked).toEqual([NAMING_SOURCE]);
  });

  test('pays for one check per activation, however many times it is opened', async () => {
    const { harness, userPlane, asked } = await legacyWorkspace();

    await harness.agent.getWorkspaceSnapshot();
    await harness.agent.harnessSettleBackgroundTasks();
    await harness.agent.getWorkspaceSnapshot();
    await harness.agent.harnessSettleBackgroundTasks();

    expect(asked).toEqual([NAMING_SOURCE]);
    expect(userPlane.titles).toEqual([PROVISIONAL_TITLE, GENERATED_TITLE]);
  });

  test('never holds the mount payload behind the naming call', async () => {
    const released = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const { harness, userPlane, asked } = await legacyWorkspace({
      reached: () => { reached.resolve(); },
      release: released.promise,
    });

    // The frame is started, NOT awaited yet, so the lane it launches can reach
    // its model while the payload is still being assembled.
    const opening = harness.agent.getWorkspaceSnapshot();
    await reached.promise;

    // The naming call is parked right now, and the payload answers anyway. That
    // is the whole reason the lane is detached from this frame rather than
    // awaited by it: an open must never wait on a provider.
    expect(await opening).toMatchObject({ status: expect.any(Object) });
    expect(asked).toEqual([NAMING_SOURCE]);

    released.resolve();
    await harness.agent.harnessSettleBackgroundTasks();
    expect(userPlane.titles).toEqual([PROVISIONAL_TITLE, GENERATED_TITLE]);
  });
});
