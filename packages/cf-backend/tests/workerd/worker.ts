/**
 * Durable Object shapes reduced to the platform behaviour each defect turned on:
 * `bun test` has no output gate, input gate, or actor-shutdown cancellation.
 */
import { DurableObject } from 'cloudflare:workers';

export { EvictionProbeDO, WitnessDO } from './eviction-probe';

export { FiberRecoveryProbeAgent } from './agent-fiber-recovery-probe';

export { SpendProbeDO } from './spend-probe';

export { ForkSourceProbeDO, ForkTargetProbeDO } from './fork-probe';

export { DeviceLedgerProbeDO } from './device-inflight-probe';

export { TerminalEffectProbeDO } from './terminal-effect-probe';

// Needs `ctx.storage.transactionSync` and `… RETURNING`, which only the platform provides.
export { DbCapabilityProbeDO } from './db-capability-probe';

export { FilesEioProbeDO } from './files-eio-probe';

export { SlateProcessProbeDO, SlateChainProbe } from './slate-process-probe';

// Exported exactly as `src/server.ts` does, for the `exports` loopback under our compatibility date.
export { CodemodeEgress } from '../../src/codemode-egress';

// Readiness refusal as data: it cannot ride an error class over RPC.
export { DevboxNotReadyProbeDO } from './devbox-not-ready-probe';

import * as v from 'valibot';
import {
  bindActorHandle, CacheWarmStore, CacheWarmingLane, initCacheWarmTable,
  type SqlExecutor, type SqlValue,
} from '@kinu.run/core';
import { KinuError, renderThrownChain } from '@kinu.run/core/obs';

/** Parsed, not probed: fails on a body that is not a replay. */
const ReplayBodySchema = v.looseObject({ max_tokens: v.number(), stream: v.optional(v.boolean()) });

/** Probes hold `ctx.storage.sql` rather than an Agents-SDK `Agent`, so `bindAgentSql` does not fit. */
function doSqlExecutor(sql: SqlStorage): SqlExecutor {
  return <Row,>(strings: TemplateStringsArray, ...values: SqlValue[]): Row[] =>
    sql.exec<Row & Record<string, SqlStorageValue>>(strings.join('?'), ...values).toArray();
}

/** Cap'n Web owns a transferred writable stream after the RPC that returned it. */
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

/** Same key as `armTimer` in orchestrator.ts. */
const ARMED = 'kinu_timer_armed_at';

/**
 * Module-level so `anti-slop/no-wait-until-in-durable-object` blesses it as an injected seam;
 * this is the experiment that rule's rationale rests on.
 */
function retainViaWaitUntil(state: DurableObjectState, work: Promise<void>): void {
  state.waitUntil(work);
}

/**
 * `do.wait_until.no_op` / `do.background_task.cancelled_on_reset`: under workerd only the
 * awaited arm survives; the others are cancelled by actor shutdown with the exception swallowed.
 */
export class RetentionDO extends DurableObject<Cloudflare.Env> {
  private async armTimer(delayMs: number): Promise<void> {
    await scheduler.wait(delayMs);
    await this.ctx.storage.put(ARMED, Date.now());
  }

  /** Shipped shape: the output gate holds the response until the row commits. */
  async scheduleAwaited(delayMs: number): Promise<void> {
    await this.armTimer(delayMs);
  }

  /** Pre-fix shape. */
  scheduleViaWaitUntil(delayMs: number): void {
    retainViaWaitUntil(this.ctx, this.armTimer(delayMs));
  }

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

/** The neighbour DO the `onStart` -> `ensureOwnedScaffold` chain ended in. */
export class NeighbourDO extends DurableObject<Cloudflare.Env> {
  async beBusy(ms: number): Promise<void> {
    await scheduler.wait(ms);
  }
}

/**
 * `do.block_concurrency.cancel_ms` / `do.init_gate.awaited_by`: partyserver runs `onStart()`
 * inside `blockConcurrencyWhile`. Name `stall:<ms>` picks the stall; `stall:0` is the shipped shape.
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

  /** No I/O of its own: whatever this costs is the gate. */
  ping(): number {
    return this.ctx.storage.sql.exec<{ v: number }>('SELECT 1 AS v').one().v;
  }
}

/**
 * `ctx.storage.transactionSync` atomicity, which `receiveSubordinateEvent` and a fork's publication
 * rely on. The bun arm runs the body directly with no atomicity; `runDirectly` is that control.
 */
export class TransactionDO extends DurableObject<Cloudflare.Env> {
  private ensureSchema(): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS event_log (id TEXT PRIMARY KEY)');
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS actor_subordinates (
         name TEXT PRIMARY KEY, status TEXT NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO actor_subordinates (name, status) VALUES ('relay', 'working')",
    );
  }

  /** `failRoster` throws after the event row lands, the only order that can orphan it. */
  private admitBody(id: string, failRoster: boolean): void {
    this.ctx.storage.sql.exec('INSERT INTO event_log (id) VALUES (?)', id);

    if (failRoster) throw new Error('unknown subordinate "relay"');
    this.ctx.storage.sql.exec(
      "UPDATE actor_subordinates SET status = 'idle' WHERE name = 'relay'",
    );
  }

  /** Shipped shape. */
  admitAtomically(id: string, failRoster: boolean): void {
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => { this.admitBody(id, failRoster); });
  }

  /** The bun arm: same body, same failure, no atomicity. */
  runDirectly(id: string, failRoster: boolean): void {
    this.ensureSchema();
    this.admitBody(id, failRoster);
  }

  /**
   * Why the seam is `transaction<T>(body: () => T): T`: `transactionSync` commits when the callback
   * returns, so an `async` body commits at its first `await` and a later throw rolls nothing back.
   */
  async admitViaAsyncBody(id: string): Promise<void> {
    this.ensureSchema();
    await this.ctx.storage.transactionSync(async () => {
      this.ctx.storage.sql.exec('INSERT INTO event_log (id) VALUES (?)', id);
      await scheduler.wait(1);
      throw new Error('unknown subordinate "relay"');
    });
  }

  async admitted(): Promise<{ events: number; rosterStatus: string }> {
    this.ensureSchema();

    return {
      events: this.ctx.storage.sql.exec<{ n: number }>(
        'SELECT COUNT(*) AS n FROM event_log',
      ).one().n,
      rosterStatus: this.ctx.storage.sql.exec<{ status: string }>(
        "SELECT status FROM actor_subordinates WHERE name = 'relay'",
      ).one().status,
    };
  }
}

/** A schema, not a type: an attachment outlives the code that wrote it, so it is untrusted input. */
const DeviceAttachmentSchema = v.object({
  device: v.string(),
  probe: v.optional(v.object({
    present: v.array(v.string()),
    probedAt: v.number(),
  })),
});

type DeviceAttachment = v.InferOutput<typeof DeviceAttachmentSchema>;

/**
 * Hibernatable socket attachments survive an isolate reset; in-memory fields do not.
 * The bun fake makes `serializeAttachment` a no-op, so only workerd can host this.
 */
export class SocketDO extends DurableObject<Cloudflare.Env> {
  /** What a reset takes: in-memory state like `DeviceConsentRegistry.inflight`. */
  private readonly waiting = new Map<string, string>();

  override async fetch(request: Request): Promise<Response> {
    const deviceId = new URL(request.url).searchParams.get('device') ?? 'unknown';
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [`device:${deviceId}`]);
    pair[1].serializeAttachment({ device: deviceId });

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * An attachment is structured-cloned, not JSON-encoded: a `Set` survives as a `Set`
   * and `DeviceAttachmentSchema` then rejects it. `asSet` is that trap.
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

  /** Null when the parse fails: the attachment is untrusted on the way back. */
  probeRecord(deviceId: string): DeviceAttachment | null {
    const socket = this.liveSocket(deviceId);

    if (!socket) return null;
    const parsed = v.safeParse(DeviceAttachmentSchema, socket.deserializeAttachment());

    return parsed.success ? parsed.output : null;
  }

  isConnected(deviceId: string): boolean {
    return this.liveSocket(deviceId) !== null;
  }

  private liveSocket(deviceId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(`device:${deviceId}`)) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }

    return null;
  }

  /** Same fact in a field and in storage, so a reset takes exactly one. */
  async raise(consentId: string): Promise<void> {
    this.waiting.set(consentId, 'pending');
    await this.ctx.storage.put(`consent:${consentId}`, 'pending');
  }

  async settled(consentId: string): Promise<{ inMemory: boolean; inStorage: boolean }> {
    return {
      inMemory: this.waiting.has(consentId),
      inStorage: (await this.ctx.storage.get<string>(`consent:${consentId}`)) !== undefined,
    };
  }
}

export interface AlarmReport {
  readonly fires: number;
  readonly completed: boolean;
  readonly next: number | null;
}

/**
 * `armTimer`'s soonest-wins dedup is only correct if a second `setAlarm` replaces the first,
 * and the SDK rethrows transient failures to rely on the runtime's alarm retry.
 */
export class AlarmDO extends DurableObject<Cloudflare.Env> {
  async arm(delayMs: number): Promise<void> {
    await this.ctx.storage.put('fires', 0);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /** Later first: a queuing slot fires twice, a replacing slot once. */
  async armTwice(firstDelayMs: number, secondDelayMs: number): Promise<void> {
    await this.ctx.storage.put('fires', 0);
    await this.ctx.storage.setAlarm(Date.now() + firstDelayMs);
    await this.ctx.storage.setAlarm(Date.now() + secondDelayMs);
  }

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
      // Uncaught on purpose: hands the retry decision to the runtime.
      throw new Error('alarm-body-failed');
    }

    await this.ctx.storage.put('completedAt', Date.now());
  }

  async report(): Promise<AlarmReport> {
    return {
      fires: (await this.ctx.storage.get<number>('fires')) ?? 0,
      completed: (await this.ctx.storage.get<number>('completedAt')) !== undefined,
      next: await this.ctx.storage.getAlarm(),
    };
  }
}

/**
 * Reached over `SELF`, a real workerd HTTP peer: workerd derives framing from the body and
 * discards an author-set `content-length`; bun's `Request` sets none at all.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const body = await request.arrayBuffer();

    return Response.json({
      contentLength: request.headers.get('content-length'),
      transferEncoding: request.headers.get('transfer-encoding'),
      userAgent: request.headers.get('user-agent'),
      bytes: body.byteLength,
    });
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export interface CacheWarmReport {
  readonly sentMaxTokens: readonly number[];
  /** Whether any replay dropped the streaming flag the real request carried. */
  readonly sentStreaming: boolean;
  readonly spendSources: readonly string[];
  readonly wakes: readonly number[];
  readonly nextWarmAt: number | null;
  readonly refused: string | null;
  readonly fires: number;
}

/**
 * Cache warm on workerd: the obligation is a DO SQLite UPSERT, the wake a real `alarm()` frame,
 * and the suppression counter must be read from storage in the woken frame, not a field.
 */
export class CacheWarmProbeDO extends DurableObject<Cloudflare.Env> {
  private readonly sentMaxTokens: number[] = [];
  private readonly spendSources: string[] = [];
  private readonly wakes: number[] = [];
  private sentStreaming = false;
  private fires = 0;
  private armed: Promise<void> = Promise.resolve();
  private readonly woken: (() => void)[] = [];
  private refuseNext = false;
  private refused: string | null = null;
  private lane: CacheWarmingLane | undefined;

  private get warming(): CacheWarmingLane {
    if (!this.lane) {
      initCacheWarmTable((ddl: string) => { this.ctx.storage.sql.exec(ddl); });

      const sql = doSqlExecutor(this.ctx.storage.sql);

      const actor = bindActorHandle(sql, {
        actorId: 'cache-warm-probe', workspaceId: 'ws-probe', parentActorId: null,
        name: 'cache-warm-probe', storageKey: 'agent:cache-warm-probe',
      }, () => {});

      this.lane = new CacheWarmingLane({
        store: new CacheWarmStore(sql, actor),
        wake: (at) => {
          this.wakes.push(at);

          // Soonest-wins on the object's one alarm slot, awaited by the arming RPC so it is durable.
          this.armed = this.ctx.storage.setAlarm(Math.max(at, Date.now()));
        },
        send: async ({ modelSpec, body }) => {
          if (modelSpec.provider !== 'anthropic') return null;

          if (this.refuseNext) {
            this.refuseNext = false;

            throw new KinuError('unavailable', 'the cache warm answered 401: {"type":"error"}');
          }

          const replay = v.parse(ReplayBodySchema, body);
          this.sentMaxTokens.push(replay.max_tokens);

          if (replay.stream !== undefined) this.sentStreaming = true;

          return { usage: { input: 40_004, cacheRead: 40_000, cacheWrite: 0, output: 0 } };
        },
        spend: (report) => { this.spendSources.push(report.source); },
        now: () => Date.now(),
      });
    }

    return this.lane;
  }

  /** `sentAtOffsetMs` backdates the send so the TTL-minus-lead point is reachable. */
  async armFromTurn(input: {
    provider: string;
    retention: 'none' | 'short' | 'long';
    sentAtOffsetMs: number;
    cacheRead: number;
    cacheWrite: number;
  }): Promise<number | null> {
    const at = this.warming.armAfterTurn({
      modelSpec: { provider: input.provider, modelId: 'claude-opus-4-7' },
      retention: input.retention,
      lastRequest: {
        body: {
          model: 'claude-opus-4-7', max_tokens: 64_000, stream: true,
          system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: 'hello' }],
        },
        sentAt: Date.now() - input.sentAtOffsetMs,
        usage: { input: 40_004, cacheRead: input.cacheRead, cacheWrite: input.cacheWrite },
      },
    });

    await this.armed;

    return at;
  }

  async refuseNextSend(): Promise<void> {
    this.refuseNext = true;
  }

  async noteRealRequest(): Promise<void> {
    this.warming.noteRequest();
  }

  override async alarm(): Promise<void> {
    this.fires += 1;

    // Like the tick's `alarm.cache_warm` phase: catch and continue, so a refused warm is state.
    try {
      await this.warming.runDue(Date.now());
    } catch (cause) {
      this.refused = renderThrownChain({ cause }).slice(0, 120);
    }

    for (const resolve of this.woken.splice(0)) resolve();
  }

  /** Waits on the state the delivery leaves: a frame already taken answers at once. */
  async reportAfterWake(): Promise<CacheWarmReport> {
    if (this.fires === 0) await new Promise<void>((resolve) => { this.woken.push(resolve); });

    return this.report();
  }

  async report(): Promise<CacheWarmReport> {
    return {
      sentMaxTokens: [...this.sentMaxTokens],
      sentStreaming: this.sentStreaming,
      spendSources: [...this.spendSources],
      wakes: [...this.wakes],
      nextWarmAt: this.warming.nextWarmAt(),
      refused: this.refused,
      fires: this.fires,
    };
  }
}
