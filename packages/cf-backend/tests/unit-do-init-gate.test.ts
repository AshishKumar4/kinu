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
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestratorHarness } from './helpers/actor-harness';
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

describe('the scaffold precondition moved to the turn, and is still reached', () => {
  const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');

  test('prepareTurn awaits it, so every turn path is covered', () => {
    // `prepareTurn` is the loop's one preparation seam, so every turn path awaits `readTurnInputs` through it.
    const prepareTurn = actor.slice(
      actor.indexOf('protected async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease)'),
      actor.indexOf('this.actorSession.bindProfile(lease, assembled.profile, assembled.profileInputs);'),
    );

    expect(prepareTurn).toContain('await this.readTurnInputs(');

    const reads = actor.slice(
      actor.indexOf('private async readTurnInputs(tools: ToolSet)'),
      actor.indexOf('this.profileInputs(),'),
    );

    expect(reads).toContain('await this.ensureOwnedScaffold()');
  });

  test('it is declared once on the shared actor base, not per root', () => {
    expect(actor.match(/ensureOwnedScaffold\(\): Promise<void>/g)).toHaveLength(1);
    const orchestrator = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf8');
    expect(orchestrator).not.toContain('ensureOwnedScaffold(): Promise<void>');
  });
});
