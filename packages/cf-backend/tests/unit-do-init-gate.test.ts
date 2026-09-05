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
 * So the invariant is not "onStart may await these things". It is that `onStart`
 * awaits nothing: every override is declared to return `void`, which makes an
 * `await` added there a compile error (TS1308). The annotation is not
 * self-enforcing — the base declares `void | Promise<void>`, so widening the
 * signature to `async` typechecks — which is what this pins, and what
 * `scripts/do-init-gate.ts` generalises to any DO class added later.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestratorHarness } from './helpers/actor-harness';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
// Dynamic on purpose, exactly as tests/helpers/actor-harness.ts:24-27 does: the
// real `agents` dist reaches `cloudflare:*`, so the SDK mock must be registered
// before these modules evaluate, and a static import would hoist above it.
const { OrchestratorAgent } = await import('../src/orchestrator');
const { SubordinateAgent } = await import('../src/subordinate-agent');

/** Every Kinu class whose `onStart` runs inside `blockConcurrencyWhile`,
 *  with the shape its gate is ALLOWED to have. The orchestrator is async by
 *  the owner's 2026-08-31 ruling — bounded once-per-start work stays in the
 *  gate, concretely the workspace boot — and `gate:do-init` holds every await
 *  in it to the pinned admitted list. The facet class stays synchronous in
 *  every mode: its activation is DDL plus a detached fiber, whatever seed it
 *  later takes. UserDO declares no override, MonitorDO is a plain DurableObject
 *  with no partyserver gate, and KinuSandbox is a third-party base. */
const GATED_CLASSES = [
  ['OrchestratorAgent', OrchestratorAgent, 'AsyncFunction'],
  ['SubordinateAgent', SubordinateAgent, 'Function'],
] as const;

describe('no Durable Object awaits anything unadmitted inside its init gate', () => {
  for (const [name, Actor, allowedConstructor] of GATED_CLASSES) {
    test(`${name}.onStart has its allowed gate form`, () => {
      // The real prototype member, not its source: an async override reports
      // 'AsyncFunction' here however it was written.
      expect(Actor.prototype.onStart.constructor.name).toBe(allowedConstructor);
    });
  }

  test('a cold activation answers a pure read, and the boot cannot wedge it', async () => {
    // The harness NIMBUS_SESSION binding is `{}` — the runtime cache is
    // unusable. The awaited boot composes the workspace over this object's own
    // SQLite regardless, and a boot FAILURE is classified rather than thrown,
    // so the activation always completes and a pure read always answers.
    const harness = orchestratorHarness();
    expect(await harness.agent.listAgentTasks()).toEqual([]);
  });
});

describe('the scaffold precondition moved to the turn, and is still reached', () => {
  const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');

  test('beforeTurn awaits it, so every turn path is covered', () => {
    const beforeTurn = actor.slice(
      actor.indexOf('async beforeTurn(ctx: TurnContext)'),
      actor.indexOf('this.orch.beginTurn('),
    );
    expect(beforeTurn).toContain('await this.ensureOwnedScaffold()');
  });

  test('it is declared once on the shared actor base, not per root', () => {
    // Two `onStart` copies collapsed into one call on the turn path; a second
    // declaration would be the duplication that produced them.
    expect(actor.match(/ensureOwnedScaffold\(\): Promise<void>/g)).toHaveLength(1);
    for (const file of ['orchestrator.ts', 'subordinate-agent.ts']) {
      const source = readFileSync(join(import.meta.dir, '..', 'src', file), 'utf8');
      expect(source).not.toContain('ensureOwnedScaffold(): Promise<void>');
    }
  });
});
