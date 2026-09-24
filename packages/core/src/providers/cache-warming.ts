/**
 * Prompt-cache warming: re-send the last request with `max_tokens: 0` before Anthropic's five-minute entry
 * expires (docs/research/harness/anthropic-sources.md §2). Armed only after a read with no write.
 */

import { formatModelSpec, modelSpecHead, parseModelSpec, type ModelSpec, type CacheRetention } from './types';
import type { Usage } from '../usage';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ModelCallReport } from '../events/model-call';
import type { CallAccount } from './quota';
import { toKinuError } from '../obs/index';
import * as v from 'valibot';
import { isJsonObject, JsonObjectSchema, parseJsonObject, type JsonObject } from '../utils/json';

/** Only the direct provider: through a gateway the cache entry is not Anthropic's to refresh. */
const WARMABLE_PROVIDER = 'anthropic';

/** Anthropic's default (short) entry lifetime. */
const CACHE_WARM_TTL_MS = 5 * 60_000;

/** Lead before expiry; the vendor's guidance (every four minutes) is more conservative. */
const CACHE_WARM_LEAD_MS = 15_000;

/** Refreshes per idle stretch (about twenty minutes); a real request re-arms from zero. */
const CACHE_WARM_LIMIT = 3;

/** The vendor rules out `max_tokens: 1`; zero output tokens are billed. */
const CACHE_WARM_MAX_TOKENS = 0;

/** The last real answer. `requestSentAt` is when the request was sent, not answered;
 *  absent cache fields are no evidence of a read, so no warm. */
interface WarmedResponse extends Pick<Usage, 'cacheRead' | 'cacheWrite'> {
  readonly requestSentAt: number;
  readonly retention: CacheRetention;
}

interface WarmingPlanInput {
  readonly modelSpec: ModelSpec;
  readonly lastResponse: WarmedResponse;
  /** Warms already sent in this idle stretch. Zero right after a real request. */
  readonly idleRefreshes: number;
  readonly now: number;
}

/** When the next warm is due; a past `at` is late, not void. */
interface WarmingPlan {
  readonly at: number;
}

/** When to warm this prefix, or null for never on this evidence. Pure. */
function warmingPlan(input: WarmingPlanInput): WarmingPlan | null {
  const { lastResponse: last } = input;

  if (input.modelSpec.provider !== WARMABLE_PROVIDER) return null;

  // Only the five-minute default expires soon enough to be worth a request.
  if (last.retention !== 'short') return null;

  if (input.idleRefreshes >= CACHE_WARM_LIMIT) return null;

  // Worth keeping only after a read with no write; a write means the prefix moved.
  if ((last.cacheRead ?? 0) <= 0 || (last.cacheWrite ?? 0) !== 0) return null;

  return { at: last.requestSentAt + CACHE_WARM_TTL_MS - CACHE_WARM_LEAD_MS };
}

/**
 * The warm request: the last request's own body with `max_tokens: 0` and no `stream`, so the prefix is byte-identical.
 * Null for an explicit thinking budget: Anthropic requires `max_tokens` above `budget_tokens`.
 */
function warmRequestBody(body: JsonObject): JsonObject | null {
  const thinking = body.thinking;

  if (isJsonObject(thinking) && thinking.budget_tokens !== undefined) return null;
  const warm: JsonObject = {};

  for (const [key, value] of Object.entries(body)) {
    if (key !== 'stream') warm[key] = value;
  }

  warm.max_tokens = CACHE_WARM_MAX_TOKENS;

  return warm;
}

/** Anthropic's `usage` block normalized; `input` is cache-inclusive as the SDK sums it, omitted fields stay absent. */
const WarmUsageSchema = v.looseObject({
  input_tokens: v.optional(v.number()),
  output_tokens: v.optional(v.number()),
  cache_read_input_tokens: v.optional(v.number()),
  cache_creation_input_tokens: v.optional(v.number()),
});

export function warmUsage(usage: JsonObject): Usage {
  const parsed = v.safeParse(WarmUsageSchema, usage);

  if (!parsed.success) return {};
  const { input_tokens: fresh, output_tokens: output } = parsed.output;
  const { cache_read_input_tokens: read, cache_creation_input_tokens: write } = parsed.output;
  const reported: { -readonly [K in keyof Usage]: number } = {};

  if (fresh !== undefined || read !== undefined || write !== undefined) {
    reported.input = (fresh ?? 0) + (read ?? 0) + (write ?? 0);
  }

  if (read !== undefined) reported.cacheRead = read;

  if (write !== undefined) reported.cacheWrite = write;

  if (output !== undefined) reported.output = output;

  return reported;
}

/**
 * The warm obligation, one row per actor. `requests` is durable because the Durable Object that arms a warm
 * has usually hibernated before it fires, and an in-memory counter would read zero.
 */
export function initCacheWarmTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS cache_warm (
    actor_id       TEXT PRIMARY KEY,
    requests       INTEGER NOT NULL,
    refreshes      INTEGER NOT NULL,
    due_at         INTEGER,
    armed_requests INTEGER,
    spec           TEXT,
    model_id       TEXT,
    retention      TEXT,
    body           TEXT
  )`);
}

/** A due warm: the frozen request and the refreshes already spent this idle stretch. */
interface DueWarm {
  readonly modelSpec: ModelSpec;
  readonly retention: CacheRetention;
  readonly body: JsonObject;
  readonly refreshes: number;
}

interface CacheWarmRow {
  readonly requests: number;
  readonly refreshes: number;
  readonly due_at: number | null;
  readonly armed_requests: number | null;
  readonly spec: string | null;
  readonly model_id: string | null;
  readonly retention: string | null;
  readonly body: string | null;
}

/** Half the SQLite-backed Durable Object 2,000,000-byte row cap (developers.cloudflare.com/durable-objects/platform/limits);
 *  a larger write would fail the arming turn. */
const CACHE_WARM_MAX_BODY_BYTES = 1_000_000;

export class CacheWarmStore {
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle) {}

  private row(): CacheWarmRow | undefined {
    this.actor.assertCurrent();

    return this.sql<CacheWarmRow>`
      SELECT requests, refreshes, due_at, armed_requests, spec, model_id, retention, body
      FROM cache_warm WHERE actor_id = ${this.actor.actorId}`[0];
  }

  /**
   * A real provider request is starting: bump the counter, which voids any pending warm.
   * A counter rather than a `due_at` write, so a wake delivered mid-stream still sees the mismatch.
   */
  noteRequest(): void {
    this.actor.assertCurrent();
    void this.sql`
      INSERT INTO cache_warm (actor_id, requests, refreshes) VALUES (${this.actor.actorId}, 1, 0)
      ON CONFLICT(actor_id) DO UPDATE SET requests = cache_warm.requests + 1, refreshes = 0`;
  }

  /** Arm the warm this turn earned; false when the frozen body is too large to store. */
  arm(input: { at: number; modelSpec: ModelSpec; retention: CacheRetention; body: JsonObject }): boolean {
    this.actor.assertCurrent();
    const body = JSON.stringify(input.body);

    if (body.length > CACHE_WARM_MAX_BODY_BYTES) return false;
    void this.sql`
      INSERT INTO cache_warm (actor_id, requests, refreshes, due_at, armed_requests, spec, model_id, retention, body)
      VALUES (${this.actor.actorId}, 1, 0, ${input.at}, 1, ${modelSpecHead(input.modelSpec)}, ${input.modelSpec.modelId},
              ${input.retention}, ${body})
      ON CONFLICT(actor_id) DO UPDATE SET
        refreshes = 0, due_at = ${input.at}, armed_requests = cache_warm.requests,
        spec = ${modelSpecHead(input.modelSpec)}, model_id = ${input.modelSpec.modelId},
        retention = ${input.retention}, body = ${body}`;

    return true;
  }

  /** When the next warm is owed, or null. Must ask exactly what {@link due} asks, or the wake fold loops. */
  dueAt(): number | null {
    const row = this.row();

    if (!row || row.armed_requests !== row.requests) return null;

    return row.due_at;
  }

  /** The warm to send now, or null; also null once a later real request bumped `requests`. */
  due(now: number): DueWarm | null {
    const row = this.row();

    if (!row || row.due_at === null || row.due_at > now) return null;

    if (row.armed_requests !== row.requests) return null;

    if (row.spec === null || row.model_id === null || row.body === null) return null;
    const retention = row.retention;

    if (retention !== 'short' && retention !== 'long' && retention !== 'none') return null;

    return {
      modelSpec: parseModelSpec(`${row.spec}/${row.model_id}`),
      retention,
      body: parseJsonObject(row.body),
      refreshes: row.refreshes,
    };
  }

  /** One warm sent: count it, and arm the next one the policy allows. */
  refreshed(input: { at: number | null; refreshes: number }): void {
    this.actor.assertCurrent();
    void this.sql`
      UPDATE cache_warm SET refreshes = ${input.refreshes}, due_at = ${input.at}
      WHERE actor_id = ${this.actor.actorId}`;
  }

  /** Stop warming this prefix, keeping the counter. */
  retire(): void {
    this.actor.assertCurrent();
    void this.sql`
      UPDATE cache_warm SET due_at = NULL, armed_requests = NULL, body = NULL
      WHERE actor_id = ${this.actor.actorId}`;
  }
}

/** What one warm did, for the caller that has to record it. */
export interface WarmOutcome {
  /** The provider's report for the warm request, `{}` when it said nothing. */
  readonly usage: Usage;
  readonly account?: CallAccount | undefined;
}

/** The backend's half of warming: storage, wake arming, provider access, spend recording. */
export interface CacheWarmSeams {
  readonly store: CacheWarmStore;
  /** Arm the backend's durable wake for `at`; never a bare `setTimeout` in a Durable Object (lost to hibernation). */
  wake(at: number): void;
  /** Send one warm through the frozen request's provider; null (unreachable) retires the chain. */
  send(input: { modelSpec: ModelSpec; body: JsonObject }): Promise<WarmOutcome | null>;
  /** Record the warm's spend under `source: 'warming'`, never as a turn. */
  spend(report: ModelCallReport): void;
  now(): number;
}

/** The warm lifecycle: arm after a turn, fire on a wake, re-arm or stop. */
export class CacheWarmingLane {
  constructor(private readonly seams: CacheWarmSeams) {}

  /** A real provider request is starting. */
  noteRequest(): void {
    this.seams.store.noteRequest();
  }

  /** When this actor's next warm is owed, for the backend's wake fold. */
  nextWarmAt(): number | null {
    return this.seams.store.dueAt();
  }

  /**
   * Consider a warm for the request this turn ended on; null when the policy declined.
   * A declined turn also retires whatever was armed before it.
   */
  armAfterTurn(input: {
    readonly modelSpec: ModelSpec;
    readonly retention: CacheRetention;
    readonly lastRequest: { readonly body: unknown; readonly sentAt: number; readonly usage: Usage } | undefined;
  }): number | null {
    const body = v.safeParse(JsonObjectSchema, input.lastRequest?.body);

    if (input.lastRequest === undefined || !body.success) {
      this.seams.store.retire();

      return null;
    }

    const plan = warmingPlan({
      modelSpec: input.modelSpec,
      lastResponse: {
        requestSentAt: input.lastRequest.sentAt,
        cacheRead: input.lastRequest.usage.cacheRead,
        cacheWrite: input.lastRequest.usage.cacheWrite,
        retention: input.retention,
      },
      idleRefreshes: 0,
      now: this.seams.now(),
    });

    if (plan === null) {
      this.seams.store.retire();

      return null;
    }

    if (!this.seams.store.arm({ at: plan.at, modelSpec: input.modelSpec, retention: input.retention, body: body.output })) {
      return null;
    }

    this.seams.wake(plan.at);

    return plan.at;
  }

  /** Run the warm this wake was armed for, if still owed; null when nothing was due. */
  async runDue(now: number): Promise<{ readonly usage: Usage } | null> {
    const due = this.seams.store.due(now);

    if (due === null) return null;
    const body = warmRequestBody(due.body);

    if (body === null) {
      this.seams.store.retire();

      return null;
    }

    const sentAt = this.seams.now();
    let outcome: WarmOutcome | null;

    try {
      outcome = await this.seams.send({ modelSpec: due.modelSpec, body });
    } catch (cause) {
      // A failed warm is not retried, and the row is retired before the throw: a row left armed
      // with a past `due_at` turns a 429 into one request per second.
      this.seams.store.retire();

      throw toKinuError({ doing: 'warming the prompt-cache prefix', cause, otherwise: 'unavailable' });
    }

    if (outcome === null) {
      this.seams.store.retire();

      return null;
    }

    const spec = formatModelSpec(due.modelSpec);
    this.seams.spend({ source: 'warming', usage: outcome.usage, spec, modelId: due.modelSpec.modelId, account: outcome.account });
    const refreshes = due.refreshes + 1;

    const next = warmingPlan({
      modelSpec: due.modelSpec,
      lastResponse: {
        requestSentAt: sentAt,
        cacheRead: outcome.usage.cacheRead,
        cacheWrite: outcome.usage.cacheWrite,
        retention: due.retention,
      },
      idleRefreshes: refreshes,
      now: sentAt,
    });

    this.seams.store.refreshed({ at: next?.at ?? null, refreshes });

    if (next !== null) this.seams.wake(next.at);

    return { usage: outcome.usage };
  }
}
