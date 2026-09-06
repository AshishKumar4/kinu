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

// The one production class hosted here — see steer-probe.ts for the charter exception.
export { SteerProbeDO } from './steer-probe';
// The eviction probes — the same charter exception, for the recovery machinery.
export { EvictionProbeDO, WitnessDO } from './eviction-probe';
export { FiberRecoveryProbeAgent } from './agent-fiber-recovery-probe';
// The step-cap probes — the same charter exception, for the turn loop's bound.
export { CappedTurnProbeDO, UnboundedTurnProbeDO } from './step-cap-probe';
// The spend aggregate — the same charter exception, for the one production read
// whose method is platform SQLite features (`WITH`, `json_extract`).
export { SpendProbeDO } from './spend-probe';
export { ForkSourceProbeDO, ForkTargetProbeDO } from './fork-probe';
// The send-admission probe — the same charter exception, for the durable
// submission ledger two concurrent clients race.
export { SendAdmissionProbeDO } from './send-admission-probe';
// The durable device-command ledger — the same charter exception, for a
// precedence protocol whose whole subject is surviving an activation reset.
export { DeviceLedgerProbeDO } from './device-inflight-probe';
// The terminal-effect ledger — the same charter exception, for what one settled
// turn still owes after the isolate running its effects dies.
export { TerminalEffectProbeDO } from './terminal-effect-probe';
// The Files-tab EIO probe — the same charter exception: the real workspace
// file plane under the runtime whose CSP is the defect.
export { FilesEioProbeDO } from './files-eio-probe';
export { SlateProcessProbeDO, SlateDepthProbe } from './slate-process-probe';
// The gadget-process probe — the same charter exception: the real `GadgetHost`
// over the real file plane, under the runtime whose loader, process lifetime
// and outbound refusal are the boundary under test.
export { GadgetProcessProbeDO } from './gadget-process-probe';
// The production sandbox egress entrypoint, exported here exactly as
// `src/server.ts` exports it, so `codemode-sandbox.test.ts` can prove the
// `exports` loopback resolves it under the compatibility date we deploy.
export { CodemodeEgress } from '../../src/codemode-egress';
// The production gadget binding entrypoint, exported here exactly as
// `src/server.ts` exports it, so the probe's loopback mint resolves the
// same class production mints into a gadget isolate's `env`.
export { GadgetBinding } from '../../src/gadgets/bindings';
import * as v from 'valibot';

/**
 * Cap'n Web owns a transferred writable stream after the RPC invocation that
 * returned it. The close and abort callbacks make that lifetime durable.
 */
export class StreamLifecycleDO extends DurableObject<Cloudflare.Env> {
  private static readonly WRITE_CLOSED = 'write-closed';
  private static readonly WRITE_ABORTED = 'write-aborted';

  openWritable(): WritableStream<Uint8Array> {
    return new WritableStream({
      close: async () => await this.ctx.storage.put(StreamLifecycleDO.WRITE_CLOSED, true),
      abort: async () => await this.ctx.storage.put(StreamLifecycleDO.WRITE_ABORTED, true),
    });
  }

  async streamEffects(): Promise<{ readonly writeClosed: boolean; readonly writeAborted: boolean }> {
    return {
      writeClosed: (await this.ctx.storage.get<boolean>(StreamLifecycleDO.WRITE_CLOSED)) === true,
      writeAborted: (await this.ctx.storage.get<boolean>(StreamLifecycleDO.WRITE_ABORTED)) === true,
    };
  }
}

/** The storage key `armTimer` commits. Named after the real one so a reader of
 *  orchestrator.ts:542 recognises what is being lost. */
const ARMED = 'kinu_timer_armed_at';

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
 * Detached controls report unexpected rejections without claiming retention.
 * On actor shutdown, however, workerd's `IncomingRequest::drain()` ends
 * `result = result.catch_([](kj::Exception&&) {})`, which cancels the task
 * before its handler runs — the finding that makes
 * `anti-slop/no-sentinel-catch` right to reject a silent handler.
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
   *  a storage write that Kinu's own wake-up depends on. */
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

  /** Completion is returned to the caller instead of leaving the timer detached. */
  async scheduleFloating(delayMs: number): Promise<void> {
    try {
      await this.armTimer(delayMs);
    } catch (cause) {
      console.error('timer arm failed', cause);
    }
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
    ctx.waitUntil(ctx.blockConcurrencyWhile(async () => {
      try {
        if (Number.isFinite(stallMs) && stallMs > 0) {
          await env.NEIGHBOUR.get(env.NEIGHBOUR.idFromName('busy')).beBusy(stallMs);
        }
      } catch (cause) {
        console.error('initialization gate failed', cause);
      }
    }));
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

/**
 * The read-back contract, identical in shape to production's
 * `DeviceAttachmentSchema` (`device-hub.ts:54-72`). It is a schema and not a type
 * because that is the point: an attachment survives a code deploy, so what a
 * previous version wrote is untrusted input, and whether the parse SUCCEEDS is
 * what decides if a device is recorded as having answered.
 */
const DeviceAttachmentSchema = v.object({
  device: v.string(),
  probe: v.optional(v.object({
    present: v.array(v.string()),
    probedAt: v.number(),
  })),
});

type DeviceAttachment = v.InferOutput<typeof DeviceAttachmentSchema>;

/**
 * Defect surface 4 — what a hibernatable socket keeps, and what an isolate reset
 * takes away.
 *
 * WHAT PRODUCTION STAKES ON IT. Every Agent-class Durable Object here hibernates:
 * `Agent.options = { hibernate: true }` in the installed SDK is never overridden
 * in `packages/cf-backend/src`, so partyserver picks its
 * `HibernatingConnectionManager` for every chat and CLI socket. `UserDO` then
 * hand-rolls a SECOND hibernatable socket type for device daemons
 * (`user-do.ts:849-857` -> `device-hub.ts:106-113`), and that one keeps its
 * entire per-connection record in the socket ATTACHMENT rather than in a field:
 * `accept` writes `{ device }` (`device-hub.ts:112`), `recordProbe` rewrites it
 * with the toolchain answer (`device-hub.ts:191-201`), and `probeRecord`,
 * `liveSocket`, `isConnected` and `connectedDeviceId` all read it back through
 * `ctx.getWebSockets(tag)` (`device-hub.ts:116-121, 184-189, 203-213`).
 *
 * WHY `bun test` CANNOT HOST IT. The fake socket the gallery and the bun suites
 * use makes `serializeAttachment` a no-op and answers `deserializeAttachment()`
 * with `null` unconditionally (`gallery.tsx:315-317`). So under bun EVERY socket
 * reads as "not a device socket": `deviceIdFromSocket` is always null and
 * `probeRecord` is always null. There is no fake that could fix this and still
 * be a fake — the attachment is held by the runtime outside the isolate's heap,
 * which is the entire property being relied on.
 */
export class SocketDO extends DurableObject<Cloudflare.Env> {
  /** In-memory per-instance state, the shape production still keeps in fields:
   *  `DeviceConsentRegistry.waiting` (`safety/device-consent.ts:135`) holds
   *  `settle` closures that no attachment could carry. */
  private readonly waiting = new Map<string, string>();

  /** The upgrade path, reduced to `DeviceSocketHub.accept`
   *  (`device-hub.ts:106-113`): tag the socket with the device it belongs to and
   *  write the device id into the attachment. */
  override async fetch(request: Request): Promise<Response> {
    const deviceId = new URL(request.url).searchParams.get('device') ?? 'unknown';
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [`device:${deviceId}`]);
    pair[1].serializeAttachment({ device: deviceId });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * `recordProbe` (`device-hub.ts:191-201`), both polarities.
   *
   * `asSet` is the trap the shipped line guards against: production spells the
   * answer out as `{ present: [...probe.present], asked: [...probe.asked] }`
   * because `DeviceAttachmentSchema` reads it back as `v.array(v.string())`.
   * An attachment is structured-cloned, not JSON-encoded, so a `Set` handed
   * here survives AS a `Set` and the schema then rejects the record it wrote.
   */
  recordProbe(deviceId: string, asSet: boolean): void {
    const socket = this.liveSocket(deviceId);
    if (!socket) throw new Error(`no live socket for ${deviceId}`);
    const present = ['node', 'python3'];
    socket.serializeAttachment({
      device: deviceId,
      probe: { present: asSet ? new Set(present) : present, probedAt: 1 },
    });
  }

  /** `DeviceSocketHub.probeRecord` (`device-hub.ts:184-189`): find the socket by
   *  tag, parse its attachment, and answer null when the parse fails. The parse
   *  is the whole decision — an attachment is untrusted input on the way back,
   *  because it outlives the code that wrote it. */
  probeRecord(deviceId: string): DeviceAttachment | null {
    const socket = this.liveSocket(deviceId);
    if (!socket) return null;
    const parsed = v.safeParse(DeviceAttachmentSchema, socket.deserializeAttachment());
    return parsed.success ? parsed.output : null;
  }

  /** `DeviceSocketHub.isConnected` (`device-hub.ts:203-205`) — a live socket for
   *  this device, whatever its record parses to. */
  isConnected(deviceId: string): boolean {
    return this.liveSocket(deviceId) !== null;
  }

  /** `DeviceSocketHub.liveSocket` (`device-hub.ts:116-121`) — the tag lookup the
   *  hub has instead of a connection registry. */
  private liveSocket(deviceId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(`device:${deviceId}`)) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }
    return null;
  }

  /** One prompt raised in a field and the same fact committed to storage, so a
   *  reset can be observed to take exactly one of them. */
  async raise(consentId: string): Promise<void> {
    this.waiting.set(consentId, 'pending');
    await this.ctx.storage.put(`consent:${consentId}`, 'pending');
  }

  /** `DeviceConsentRegistry.resolve` answers false for an id it cannot find —
   *  "already settled, or from a previous instance of this host"
   *  (`safety/device-consent.ts:162-163`). */
  async settled(consentId: string): Promise<{ inMemory: boolean; inStorage: boolean }> {
    return {
      inMemory: this.waiting.has(consentId),
      inStorage: (await this.ctx.storage.get<string>(`consent:${consentId}`)) !== undefined,
    };
  }
}

/** What one object's alarm slot has done so far. Named here, at the object that
 *  owns it, so the test reads the contract rather than deriving it. */
export interface AlarmReport {
  /** Deliveries of `alarm()` counted by the handler itself. */
  readonly fires: number;
  /** The handler reached its end without throwing at least once. */
  readonly completed: boolean;
  /** The pending alarm time, or null when the runtime has cleared the slot. */
  readonly next: number | null;
}

/**
 * Defect surface 5 — the Durable Object alarm, actually fired.
 *
 * WHAT PRODUCTION STAKES ON IT. Kinu owns no `alarm()` of its own: there are
 * zero `setAlarm`/`deleteAlarm` calls and zero `alarm()` overrides in
 * `packages/cf-backend/src`. Every wake rides the installed SDK's
 * `cf_agents_schedules` table through `this.schedule(...)`, and `armTimer`
 * collapses them onto ONE row with a soonest-wins dedup, because the object has
 * exactly one alarm slot and the SDK owns it — `_scheduleNextAlarm` deletes any
 * alarm it does not recognise, "so this must never call `setAlarm` itself"
 * (`orchestrator.ts:484-485`). That dedup is only correct if a second
 * `setAlarm` REPLACES the first rather than queueing beside it.
 *
 * The SDK also leans on the platform's retry: `_executeScheduleCallback` retries
 * in-process, and on a code-update reset, a transient platform error or a memory
 * kill it deliberately RETHROWS so the schedule row survives and the runtime's
 * own alarm retry picks it up on the next invocation. That backstop is a
 * platform behaviour, not a library one.
 *
 * WHY `bun test` CANNOT HOST IT. Nothing outside workerd invokes `alarm()` at
 * all. The bun fake for the Agent SDK has no reference to alarm, schedule or
 * setAlarm, and `unit-alarm-tracing.test.ts` reaches the tick by calling
 * `_kinuTimerTick()` directly — which is the body, never the dispatch. The
 * two guards over the dispatch itself are a regex for a shadowed `alarm()`
 * missing `super.alarm()` and an AST walk; both read TEXT. Until this file
 * nothing in CI had ever observed an alarm fire.
 */
export class AlarmDO extends DurableObject<Cloudflare.Env> {
  /** Arm once. `armTimer`'s single durable wake, reduced to the platform call
   *  the SDK makes on its behalf. */
  async arm(delayMs: number): Promise<void> {
    await this.ctx.storage.put('fires', 0);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /** Arm twice, later first, so a slot that QUEUED would fire twice and a slot
   *  that REPLACES fires once. Mirrors two schedules colliding on one object. */
  async armTwice(firstDelayMs: number, secondDelayMs: number): Promise<void> {
    await this.ctx.storage.put('fires', 0);
    await this.ctx.storage.setAlarm(Date.now() + firstDelayMs);
    await this.ctx.storage.setAlarm(Date.now() + secondDelayMs);
  }

  /** Fail the first `failTimes` deliveries, then succeed — a transient failure,
   *  which is the only kind the SDK rethrows to the platform for. */
  async armFlaky(delayMs: number, failTimes: number): Promise<void> {
    await this.ctx.storage.put('fires', 0);
    await this.ctx.storage.put('failuresLeft', failTimes);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  override async alarm(): Promise<void> {
    const fires = (await this.ctx.storage.get<number>('fires')) ?? 0;
    await this.ctx.storage.put('fires', fires + 1);
    const failuresLeft = (await this.ctx.storage.get<number>('failuresLeft')) ?? 0;
    if (failuresLeft > 0) {
      await this.ctx.storage.put('failuresLeft', failuresLeft - 1);
      // Uncaught out of `alarm()` is the whole point: it is what hands the retry
      // decision to the runtime instead of keeping it in the library.
      throw new Error('alarm-body-failed');
    }
    await this.ctx.storage.put('completedAt', Date.now());
  }

  /** `fires` counts deliveries; `next` is the slot itself, which the runtime
   *  clears on a delivery it considers final. */
  async report(): Promise<AlarmReport> {
    return {
      fires: (await this.ctx.storage.get<number>('fires')) ?? 0,
      completed: (await this.ctx.storage.get<number>('completedAt')) !== undefined,
      next: await this.ctx.storage.getAlarm(),
    };
  }
}

/**
 * The send route two concurrent clients arrive on.
 *
 * One hop, resolved the way production resolves one: the conversation's name is
 * a path segment, `idFromName` turns it into the object, and the send is
 * forwarded. What it adds over calling the stub from the test is the part the
 * duplicate-send question is about — two INDEPENDENT HTTP requests, each its own
 * worker invocation, overlapping at one Durable Object.
 */
async function routeSend(request: Request, env: Cloudflare.Env, url: URL): Promise<Response> {
  const [, name, key] = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (name === undefined || key === undefined) return new Response('bad send path', { status: 400 });
  const stub = env.SEND_ADMISSION_PROBE.get(env.SEND_ADMISSION_PROBE.idFromName(name));
  return Response.json(await stub.submit(await request.text(), key));
}

/**
 * Defect 6 — transfer framing across a re-origination.
 *
 * The pool requires a default export from `main`, and it is the one thing here
 * that is a plain handler rather than a Durable Object: reached over `SELF`, it
 * is a real workerd HTTP peer, so what it reports is what the runtime actually
 * put on the wire.
 *
 * WHY `bun test` CANNOT HOST IT. Bun's `Request` sets no `content-length` at
 * all when a body is attached, so the difference between a fixed-length send
 * and a chunked one is invisible there by construction — a re-origination that
 * silently turned every upload chunked would pass every bun assertion. workerd
 * derives the framing from the body it is handed and DISCARDS an author-set
 * `content-length`, which is the semantic `egress-framing.test.ts` pins.
 *
 * The body is drained rather than ignored so `bytes` proves the payload
 * survived whichever framing was chosen.
 */
export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/send/')) return routeSend(request, env, url);
    const body = await request.arrayBuffer();
    return Response.json({
      contentLength: request.headers.get('content-length'),
      transferEncoding: request.headers.get('transfer-encoding'),
      userAgent: request.headers.get('user-agent'),
      bytes: body.byteLength,
    });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
