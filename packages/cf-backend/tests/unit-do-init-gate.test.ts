/**
 * The Durable Object init gate.
 *
 * partyserver runs `onStart()` inside `ctx.blockConcurrencyWhile()` (its
 * `#ensureInitialized`), and `fetch`, `webSocketMessage`, `webSocketClose` and
 * `alarm` all await that same gate. So anything `onStart` awaits stalls EVERY
 * event on the object — a pure `@callable` `SELECT` included — for as long as
 * the awaited thing takes, and the runtime cancels the block and RESETS the
 * object at 30 s.
 *
 * That is what produced "Couldn't load the plan — RPC call to listAgentTasks
 * timed out after 30000ms" on a workspace the owner had open: `onStart` awaited
 * `ensureOwnedScaffold()`, a cross-DO probe into the NIMBUS_SESSION object.
 * Measured in workerd against a filesystem object busy for 2 s / 10 s / 25 s /
 * 31 s, the read took 2303 / 10215 / 25212 ms and then hit the object reset;
 * with a clean `onStart` and the same busy filesystem object it took
 * 216 / 184 / 266 / 339 ms. An idle object answers it in 0-2 ms, and — the
 * hypothesis this disproves — an object parked inside a turn awaiting the model
 * answers it in 1 ms, because the DO input gate only closes around storage ops.
 *
 * So `onStart` awaits nothing: overrides return `void` (an added `await` is TS1308), and since the base declares
 * `void | Promise<void>` this pins it; `scripts/do-init-gate.ts` generalises to later DO classes.
 */
import type { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chatSessionTurns, orchestratorHarness, workspaceMainActor } from './helpers/actor-harness';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();

// Dynamic, as in tests/helpers/actor-harness.ts: the SDK mock must register before `agents` reaches `cloudflare:*`.
const { OrchestratorAgent } = await import('../src/orchestrator');

/** Every Kinu class whose `onStart` runs inside `blockConcurrencyWhile`, with its allowed gate shape. The orchestrator
 *  is async by the owner's 2026-08-31 ruling, its awaits held by `gate:do-init`; a new DO class must add its entry. */
const GATED_CLASSES = [
  ['OrchestratorAgent', OrchestratorAgent, 'AsyncFunction'],
] as const;

describe('no Durable Object awaits anything unadmitted inside its init gate', () => {
  for (const [name, Actor, allowedConstructor] of GATED_CLASSES) {
    test(`${name}.onStart has its allowed gate form`, () => {
      // The real prototype member: an async override reports 'AsyncFunction' however it was written.
      expect(Actor.prototype.onStart.constructor.name).toBe(allowedConstructor);
    });
  }

  test('a cold activation answers a pure read, and the boot cannot wedge it', async () => {
    // NIMBUS_SESSION is `{}` here; a boot failure is classified rather than thrown, so a pure read still answers.
    const harness = orchestratorHarness();
    expect(await harness.agent.listAgentTasks()).toEqual([]);
  });
});

/** Actors that own a scaffold version, as the precondition writes them. */
function scaffoldOwners(db: Database): string[] {
  return db.query<{ actor_id: string }, []>('SELECT DISTINCT actor_id FROM scaffold_versions ORDER BY actor_id').all()
    .map((row) => row.actor_id);
}

describe('the scaffold precondition moved to the turn, and is still reached', () => {
  test('activation owns no scaffold; the first turn prepares it', async () => {
    const workspace = orchestratorHarness(undefined, { freshScaffold: true });
    await workspace.agent.activateActor();
    expect(scaffoldOwners(workspace.db)).toEqual([]);

    await chatSessionTurns(workspace.agent).prepare({ messages: [{ role: 'user', content: 'hello' }] });
    expect(scaffoldOwners(workspace.db)).toEqual([workspaceMainActor(workspace.db).actorId]);
  });
});
