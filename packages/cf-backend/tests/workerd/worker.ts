/**
 * The subject of the workerd layer: Durable Object shapes reduced to the one
 * platform behaviour each historical defect turned on.
 *
 * These are NOT copies of production classes. Every guard we already ship for
 * these defects is either a source-text assertion
 * (`unit-alarm-chain-contract.test.ts:103-113` greps orchestrator.ts for the
 * absence of `this.ctx.waitUntil(`), an AST walk (`scripts/do-init-gate.ts`), or
 * a reflection (`unit-do-init-gate.test.ts` reads `onStart.constructor.name`).
 * All three assert the SHAPE. Not one of them executes the SEMANTIC the shape
 * is rejected for, and `bun test` cannot: it has no output gate, no
 * `blockConcurrencyWhile` input gate, and no actor-shutdown cancellation. So
 * the classes here are the smallest thing that makes the semantic observable —
 * a control group for a rule, not a second copy of the rule's subject.
 */
import { DurableObject } from 'cloudflare:workers';

/** The storage key `armTimer` commits. Named after the real one so a reader of
 *  orchestrator.ts:542 recognises what is being lost. */
const ARMED = 'proteus_timer_armed_at';

/**
 * The historical retention claim from `5183d69d:orchestrator.ts:518-529`,
 * isolated in a module-level function that takes the state as a parameter.
 *
 * This is deliberately NOT `this.ctx.waitUntil(...)` inside the class:
 * `anti-slop/no-wait-until-in-durable-object` rejects that receiver, and the
 * rule is not being dodged here — its own valid-case list
 * (`rules/no-wait-until-in-durable-object.test.ts:18-19`) blesses exactly this
 * shape as "an injected seam; the caller decides what retention means". The
 * rule governs production intent. This function IS the experiment the rule's
 * rationale rests on, and if workerd ever changed the semantic, the rule's
 * stated reason would be false and only this file would notice.
 *
 * The historical form also attached `.catch((err) => console.error(...))`. It
 * is omitted because it never fired: workerd's `IncomingRequest::drain()` ends
 * `result = result.catch_([](kj::Exception&&) {});`, so actor shutdown
 * cancels the task before any JS handler runs — which is the finding, and is
 * also why `anti-slop/no-sentinel-catch` is right to reject the shape.
 */
function retainViaWaitUntil(state: DurableObjectState, work: Promise<void>): void {
  state.waitUntil(work);
}

/**
 * Defect 1 — `do.wait_until.no_op` / `do.background_task.cancelled_on_reset`.
 *
 * Three retention arms over one identical write. Under `bun test` all three are
 * indistinguishable; under workerd the awaited arm is held by the output gate
 * and the other two are cancelled by actor shutdown with the exception
 * swallowed (`io-context.c++` `drain()` ends `result.catch_([](kj::Exception&&) {})`).
 */
export class RetentionDO extends DurableObject<Cloudflare.Env> {
  /** The work every arm below performs. Mirrors `OrchestratorAgent.armTimer`:
   *  a storage write that Proteus's own wake-up depends on. */
  private async armTimer(delayMs: number): Promise<void> {
    await scheduler.wait(delayMs);
    await this.ctx.storage.put(ARMED, Date.now());
  }

  /** The shipped shape (`orchestrator.ts:542`). Awaited inside the invocation,
   *  so the output gate holds the response until the row commits. */
  async scheduleAwaited(delayMs: number): Promise<void> {
    await this.armTimer(delayMs);
  }

  /** The pre-fix shape. Returns immediately and claims the write "lands even if
   *  the caller's invocation ends first". */
  scheduleViaWaitUntil(delayMs: number): void {
    retainViaWaitUntil(this.ctx, this.armTimer(delayMs));
  }

  /** The control that makes the finding sharp: a bare floating promise, which
   *  claims no retention at all. If this and `scheduleViaWaitUntil` behave
   *  identically, `waitUntil` bought nothing. */
  scheduleFloating(delayMs: number): void {
    void this.armTimer(delayMs);
  }

  async armedAt(): Promise<number | undefined> {
    return this.ctx.storage.get<number>(ARMED);
  }
}

/**
 * Defect 2, second half — the neighbour Durable Object the proven chain ended
 * in (`onStart` -> `ensureOwnedScaffold` -> `rt.identity.scaffold.exists` ->
 * `env.NIMBUS_SESSION.get(...)`).
 */
export class NeighbourDO extends DurableObject<Cloudflare.Env> {
  /** Occupies this object for `ms`, exactly as a busy filesystem DO did when
   *  the 2303 / 10215 / 25212 ms rows in `platform-catalog.ts:465` were taken. */
  async beBusy(ms: number): Promise<void> {
    await scheduler.wait(ms);
  }
}

/**
 * Defect 2 — `do.block_concurrency.cancel_ms` / `do.init_gate.awaited_by`.
 *
 * partyserver runs `onStart()` inside `ctx.blockConcurrencyWhile()`
 * (`#ensureInitialized`), and `fetch`, `webSocketMessage`, `webSocketClose` and
 * `alarm` all await that same gate. The constructor here opens the same gate
 * directly, which is what partyserver does on our behalf.
 *
 * How long init stalls is read from the object's own name (`stall:<ms>`) so one
 * class covers both polarities: `stall:0` is the shipped `onStart(): void`,
 * `stall:N` is the pre-fix `async onStart()` that awaited a second Durable
 * Object. A test names the object it wants; nothing is mocked.
 */
export class GatedDO extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const stallMs = Number.parseInt(ctx.id.name?.split(':')[1] ?? '', 10);
    ctx.blockConcurrencyWhile(async () => {
      if (Number.isFinite(stallMs) && stallMs > 0) {
        await env.NEIGHBOUR.get(env.NEIGHBOUR.idFromName('busy')).beBusy(stallMs);
      }
    });
  }

  /** A pure read with no I/O of its own — the `@callable` SELECT that answered
   *  in 25,212 ms. Whatever this costs is the gate, not the query. */
  ping(): number {
    return this.ctx.storage.sql.exec<{ v: number }>('SELECT 1 AS v').one().v;
  }
}

/**
 * Defect surface 3 — `ctx.storage.transactionSync` atomicity.
 *
 * WHAT PRODUCTION STAKES ON IT. Core declares a `transaction` seam and states
 * what it is for — "Run the admit + roster write atomically"
 * (`events/ingress/subordinate.ts:45-46`). `receiveSubordinateEvent` puts the
 * event-log insert and the roster update inside it
 * (`events/ingress/subordinate.ts:71-85`), and the CF backend satisfies it with
 * `(body) => this.ctx.storage.transactionSync(body)` (`actor-agent.ts:765`).
 * `writeForkSnapshot` shares the same primitive for a whole workspace snapshot
 * (`orchestrator.ts:3280`, `identity/fork.ts:211-213`).
 *
 * The second write throws on a LIVE path, which is what makes this load-bearing
 * rather than theoretical: `SubordinateRosterStore.applyReport` opens with
 * `requireActive(name)` (`subordinates/support.ts:393-394`), and by then the
 * event row is already inserted.
 *
 * WHY `bun test` CANNOT HOST IT. Core's seam comment gives the non-CF fallback
 * in its own words — "a backend without one runs the body directly"
 * (`events/ingress/subordinate.ts:7-8`) — and `identity/fork.ts:212-213` says
 * the bun path execs each statement separately, "where per-statement failure is
 * acceptable". The bun arm is therefore not a weaker transaction but NO
 * transaction, so every assertion here about a write failing to land is false
 * there. `runDirectly` below is that exact arm, kept as the control group.
 */
export class TransactionDO extends DurableObject<Cloudflare.Env> {
  /** Named after the two tables the production body writes. */
  private ensureSchema(): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS event_log (id TEXT PRIMARY KEY)');
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS workspace_subordinates (
         name TEXT PRIMARY KEY, status TEXT NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO workspace_subordinates (name, status) VALUES ('relay', 'working')",
    );
  }

  /**
   * The write set that must be all-or-nothing, in production's order: publish
   * the event the parent will drain, then advance the roster that says the
   * subordinate reported.
   *
   * `failRoster` models `requireActive` throwing at the top of `applyReport` —
   * after the event row has landed, which is the only ordering that can leave
   * an orphan.
   */
  private admitBody(id: string, failRoster: boolean): void {
    this.ctx.storage.sql.exec('INSERT INTO event_log (id) VALUES (?)', id);
    if (failRoster) throw new Error('unknown subordinate "relay"');
    this.ctx.storage.sql.exec(
      "UPDATE workspace_subordinates SET status = 'idle' WHERE name = 'relay'",
    );
  }

  /** The shipped shape (`actor-agent.ts:765`). */
  admitAtomically(id: string, failRoster: boolean): void {
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => { this.admitBody(id, failRoster); });
  }

  /** The seam core runs on a backend that has no transaction — the bun arm,
   *  verbatim. Same body, same failure, no atomicity. */
  runDirectly(id: string, failRoster: boolean): void {
    this.ensureSchema();
    this.admitBody(id, failRoster);
  }

  /**
   * Why the seam's type is `transaction<T>(body: () => T): T` and not a
   * promise-returning one. `transactionSync` runs its callback to completion
   * SYNCHRONOUSLY and commits when it returns; an `async` callback returns at
   * its first `await`, so the commit happens while the body is still running and
   * a later throw has nothing left to roll back.
   */
  async admitViaAsyncBody(id: string): Promise<void> {
    this.ensureSchema();
    await this.ctx.storage.transactionSync(async () => {
      this.ctx.storage.sql.exec('INSERT INTO event_log (id) VALUES (?)', id);
      await scheduler.wait(1);
      throw new Error('unknown subordinate "relay"');
    });
  }

  /** What a parent would drain, and what its roster would say. */
  async admitted(): Promise<{ events: number; rosterStatus: string }> {
    this.ensureSchema();
    return {
      events: this.ctx.storage.sql.exec<{ n: number }>(
        'SELECT COUNT(*) AS n FROM event_log',
      ).one().n,
      rosterStatus: this.ctx.storage.sql.exec<{ status: string }>(
        "SELECT status FROM workspace_subordinates WHERE name = 'relay'",
      ).one().status,
    };
  }
}

/** The pool requires a default export from `main`. Nothing routes to it: every
 *  test addresses a Durable Object stub directly. */
export default {
  fetch(): Response {
    return new Response('workerd test worker', { status: 200 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
