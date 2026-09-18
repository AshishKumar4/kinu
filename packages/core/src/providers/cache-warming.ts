/**
 * Prompt-cache warming — keeping a SHORT provider cache entry alive across an
 * idle gap by re-sending the request that wrote it, with no completion.
 *
 * WHY IT EXISTS. Anthropic's default entry lives five minutes. An owner who
 * reads the answer, thinks, and replies eight minutes later pays the whole
 * prefix again at the cache-WRITE rate; the alternative sold by the vendor for
 * that shape is the 1-hour entry, which costs 2x per write on every turn
 * whether or not a pause follows. The measured third option is to re-send the
 * last request with `max_tokens: 0` before the entry expires: "Keeping the
 * 5-minute cache warm cost 13% to 20% less per session than the 1-hour cache
 * whenever pauses ran for minutes; only with pauses near 45 minutes did the
 * 1-hour cache win, by about 12 cents a session."
 * (docs/research/harness/anthropic-sources.md §2, read 2026-09-13.)
 *
 * WHAT THE VENDOR REQUIRES of such a request, verbatim from the same source:
 * "send the previous request again with `max_tokens` set to 0 within 4 minutes
 * of the previous request's start, and every 4 minutes after that … Count from
 * the request's start, not its response's end … Do not change a byte of the
 * prefix, and do not use `max_tokens: 1` … Re-send the request's headers as
 * well as its body." And from the pre-warming rules (§23): "Use the same
 * thinking configuration and `output_config.effort` as your follow-up requests
 * too: those values are rendered into the prompt", plus "A pre-warm request
 * incurs a cache write charge if the prefix is not already cached … Zero output
 * tokens are billed."
 *
 * WHOSE RULE THIS IS. The eligibility and the cadence mirror oh-my-pi's
 * shipped implementation (`packages/ai/src/stream.ts`, read 2026-09-17):
 * `supportsAnthropicCacheRefresh` (:1292) admits only `api ===
 * 'anthropic-messages'` on `provider === 'anthropic'` with a non-pi-native
 * transport and an official endpoint; `:1435` additionally requires the
 * resolved retention to be `short`; `ANTHROPIC_CACHE_TTL_MS`,
 * `ANTHROPIC_CACHE_REFRESH_LEAD_MS` and `ANTHROPIC_CACHE_REFRESH_LIMIT`
 * (:1209-1211) are the five minutes, the fifteen-second lead and the three
 * refreshes below; `:1426` cancels a pending refresh the moment a real request
 * starts; `:1393` continues the chain only while the answer read the cache and
 * wrote none.
 *
 * ONE DECLARED DIVERGENCE from that source, and it is the owner-facing rule:
 * oh-my-pi ARMS on `cacheRead + cacheWrite > 0` (:1462) and only CONTINUES on
 * read-and-no-write, so its first refresh can follow a turn that merely wrote
 * the entry. Here one predicate governs both — a warm is armed only when the
 * last real request read the cache and wrote nothing — so a workspace whose
 * prefix is still being rewritten every turn never starts a refresh chain it
 * would only pay cache writes for.
 *
 * NO MODEL LIST. Eligibility is the provider, the endpoint, the retention and
 * what the last answer reported. Nothing here reads a price or a model SKU.
 */

import type { ModelSpec, CacheRetention } from './types';
import type { Usage } from '../usage';
import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ModelCallReport } from '../events/model-call';
import { toKinuError } from '../obs/index';
import * as v from 'valibot';
import { isJsonObject, JsonObjectSchema, parseJsonObject, type JsonObject } from '../utils/json';

/** The provider id whose endpoint, wire API and cache semantics this policy is
 *  about. A Claude model reached through a gateway (`ai-gateway`,
 *  `my-gateway`, `openrouter`, an `openai-compat` route) is NOT it: the entry
 *  belongs to whatever the gateway did with the prefix, and the 5-minute
 *  expiry this refreshes is Anthropic's own. `providers/anthropic.ts` builds
 *  the model against the official base URL with no redirect, which is what
 *  makes the id sufficient here. */
const WARMABLE_PROVIDER = 'anthropic';

/** Anthropic's default (short) entry lifetime. */
const CACHE_WARM_TTL_MS = 5 * 60_000;

/** How far before expiry a refresh is sent. Fifteen seconds is oh-my-pi's
 *  lead; the vendor's own guidance is more conservative still (every four
 *  minutes), and the difference is one refresh's worth of margin on a request
 *  that takes a second to reach the API. */
const CACHE_WARM_LEAD_MS = 15_000;

/** Refreshes per idle stretch. Three carries a pause to about twenty minutes
 *  and then stops: past that the workspace is not pausing, it is closed, and
 *  an unbounded chain would keep a prefix alive for a session nobody returns
 *  to. A real request re-arms from zero. */
const CACHE_WARM_LIMIT = 3;

/** What the vendor's pre-warm request asks for, and the value it explicitly
 *  rules out: "do not use `max_tokens: 1`". Zero output tokens are billed. */
const CACHE_WARM_MAX_TOKENS = 0;

/** The last real answer, as the policy reads it. `requestSentAt` is when the
 *  request that earned this answer was SENT, not when the answer arrived:
 *  "Count from the request's start, not its response's end."
 *
 *  `cacheRead`/`cacheWrite` keep {@link Usage}'s absence contract — an absent
 *  field is a provider that said nothing, which this reads as no evidence of a
 *  cache read and therefore no warm. */
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

/** When the next warm is due. `at` may be at or before `now` — an obligation
 *  that came due while the object was evicted is late, not void, and the
 *  scheduler that arms it is the one place that decides how to run a past-due
 *  wake. */
interface WarmingPlan {
  readonly at: number;
}

/**
 * When to warm this prefix, or null for "never, on this evidence".
 *
 * Pure: every refusal is a fact about the arguments, so the suite can state
 * each one (provider, retention, usage, cap) without a provider, a clock or a
 * database.
 */
function warmingPlan(input: WarmingPlanInput): WarmingPlan | null {
  const { lastResponse: last } = input;

  if (input.modelSpec.provider !== WARMABLE_PROVIDER) return null;

  // `long` buys an hour from the provider and needs no refresh; `none` wrote no
  // entry at all. Only the five-minute default expires soon enough to be worth
  // a request, and it is the only retention the TTL below describes.
  if (last.retention !== 'short') return null;

  if (input.idleRefreshes >= CACHE_WARM_LIMIT) return null;

  // The prefix is worth keeping only when the provider just proved it is there:
  // a read with no write. A write means the prefix moved, so the entry this
  // would refresh is already the wrong one, and the next real turn writes again
  // whatever this does.
  if ((last.cacheRead ?? 0) <= 0 || (last.cacheWrite ?? 0) !== 0) return null;

  return { at: last.requestSentAt + CACHE_WARM_TTL_MS - CACHE_WARM_LEAD_MS };
}

/**
 * The warm request: the last request's own body, with no completion.
 *
 * The body is the provider body the SDK already sent (ai v6 hands it back on
 * every step as `StepResult.request.body`), so the prefix — tools, system,
 * messages, every `cache_control` breakpoint, `output_config.effort` — is
 * byte-identical by construction rather than by a second assembly pass that
 * could drift. Two keys change, and both are the documented pre-warm shape
 * rather than prefix bytes: `max_tokens` becomes 0, and `stream` is dropped
 * because the replay is a non-streaming request (oh-my-pi
 * `packages/ai/src/types.ts:483`, "a replay-only Anthropic request that must
 * use non-streaming `max_tokens: 0`").
 *
 * Null when the body carries an explicit thinking BUDGET: Anthropic requires
 * `max_tokens` to exceed `thinking.budget_tokens`, so zero is not a legal
 * request for one. oh-my-pi handles that case by replaying with the caller's
 * own `max_tokens` and aborting the stream at the first generated token
 * (`stream.ts:1370-1376, 1397-1401`); a non-streaming replay cannot abort, so
 * it would bill a whole thinking pass for a cache touch. Kinu's Anthropic
 * requests carry `output_config.effort` (strategy/effort.ts) and no budget, so
 * this is the guard for a body shape a future provider option could produce,
 * not a path the current one takes.
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

/**
 * Anthropic's `usage` block, in the one normalized vocabulary.
 *
 * `input` is the CACHE-INCLUSIVE total, summed exactly as the SDK sums it
 * (@ai-sdk/anthropic dist/index.mjs:1870 — `inputTokens + cacheCreationTokens
 * + cacheReadTokens`), so a warm's hit rate is a share of the same base a
 * step's is and the two are comparable. The fields are read as reported: a
 * number the block omits stays absent rather than becoming a zero.
 */
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
 * The warm obligation, durably.
 *
 * ONE row per actor, because one actor has one live prefix: the newest request
 * is the only one whose entry can still be read, so a second pending warm
 * would be a refresh of a prefix nothing will ask for again.
 *
 * `requests` is the provider-request counter the fire decision compares
 * against. It is durable for the case that motivates the whole row: a Durable
 * Object hibernates within seconds of going idle, so the object that arms a
 * warm is almost never the object that runs it, and an in-memory counter would
 * read zero in the second life and fire a warm on top of a turn in flight.
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

/** A warm that is due and still owed: the frozen request to re-send, and how
 *  many refreshes this idle stretch has already had. */
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

/**
 * A stored body this large is not re-sent.
 *
 * SQLite-backed Durable Objects cap a string, BLOB or row at 2,000,000 bytes
 * (developers.cloudflare.com/durable-objects/platform/limits, read
 * 2026-09-17), and the write that would exceed it fails the turn that was
 * merely trying to arm a warm. Half the cap leaves room for the rest of the
 * row and still covers a request far larger than any this repository's
 * step-prune budget admits; a body above it arms nothing and says so.
 */
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
   * A real provider request is starting.
   *
   * Bumps the counter, and NOTHING else — the counter is what voids a pending
   * warm, which is the same collapse oh-my-pi makes when a new request finds an
   * armed refresh (`stream.ts:1426-1428`): the request about to run reads and
   * rewrites the prefix itself, so the warm behind it has nothing left to keep
   * alive. Expressed as the counter rather than as a second write of `due_at`
   * because the two would be two answers to one question, and the one that has
   * to be right is the one read in the frame the PLATFORM woke — a wake
   * delivered while this turn is still streaming must find the mismatch. The
   * turn that ends re-arms from its own last request, resetting both.
   */
  noteRequest(): void {
    this.actor.assertCurrent();
    void this.sql`
      INSERT INTO cache_warm (actor_id, requests, refreshes) VALUES (${this.actor.actorId}, 1, 0)
      ON CONFLICT(actor_id) DO UPDATE SET requests = cache_warm.requests + 1, refreshes = 0`;
  }

  /** Arm the warm this turn's last request earned. Answers false when the
   *  frozen body is too large to store (see {@link CACHE_WARM_MAX_BODY_BYTES}),
   *  so the caller reports an unarmed warm rather than a silent one. */
  arm(input: { at: number; modelSpec: ModelSpec; retention: CacheRetention; body: JsonObject }): boolean {
    this.actor.assertCurrent();
    const body = JSON.stringify(input.body);

    if (body.length > CACHE_WARM_MAX_BODY_BYTES) return false;
    void this.sql`
      INSERT INTO cache_warm (actor_id, requests, refreshes, due_at, armed_requests, spec, model_id, retention, body)
      VALUES (${this.actor.actorId}, 1, 0, ${input.at}, 1, ${input.modelSpec.provider}, ${input.modelSpec.modelId},
              ${input.retention}, ${body})
      ON CONFLICT(actor_id) DO UPDATE SET
        refreshes = 0, due_at = ${input.at}, armed_requests = cache_warm.requests,
        spec = ${input.modelSpec.provider}, model_id = ${input.modelSpec.modelId},
        retention = ${input.retention}, body = ${body}`;

    return true;
  }

  /**
   * When the next warm is owed, for a backend folding every durable wake into
   * one. Null when nothing is armed — or when a real request has since voided
   * what was.
   *
   * ASKS THE SAME QUESTION {@link due} ASKS, which is the rule for this chain:
   * a fold that answered "owed" while the fire refused would arm a wake at
   * `now` on every tick and never take the work, which is the one-second loop
   * the orchestrator's own wake fold documents.
   */
  dueAt(): number | null {
    const row = this.row();

    if (!row || row.armed_requests !== row.requests) return null;

    return row.due_at;
  }

  /**
   * The warm to send now, or null.
   *
   * Two conditions beyond the clock, and the second is the one the counter
   * exists for: `armed_requests` must still equal `requests`. A real request
   * that started after the arm has read the prefix itself — and may still be
   * streaming — so the warm is neither needed nor safe to add beside it.
   */
  due(now: number): DueWarm | null {
    const row = this.row();

    if (!row || row.due_at === null || row.due_at > now) return null;

    if (row.armed_requests !== row.requests) return null;

    if (row.spec === null || row.model_id === null || row.body === null) return null;
    const retention = row.retention;

    if (retention !== 'short' && retention !== 'long' && retention !== 'none') return null;

    return {
      modelSpec: { provider: row.spec, modelId: row.model_id },
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

  /** Stop warming this prefix, keeping the counter: the chain is over, the
   *  actor's request history is not. */
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
}

/** The backend's half of warming: where the row lives, how a wake is armed,
 *  how a request reaches the provider, and where its spend is recorded. */
export interface CacheWarmSeams {
  readonly store: CacheWarmStore;
  /** Arm the backend's DURABLE wake for `at` — the Durable Object's alarm
   *  chain, the local session's process timer. Never a bare `setTimeout` in a
   *  Durable Object: nothing survives the hibernation that follows going idle,
   *  which is the whole interval a warm waits out. */
  wake(at: number): void;
  /** Send one warm through the provider that served the frozen request.
   *  Null when this workspace cannot reach it (no credential, no such
   *  provider, no warm support), which retires the chain. */
  send(input: { modelSpec: ModelSpec; body: JsonObject }): Promise<WarmOutcome | null>;
  /** Record the warm's own spend. Never a turn: `source: 'warming'` is its own
   *  producer, so a refresh neither reads as a step of the conversation nor
   *  lands in the conversation's cache-hit distribution. */
  spend(report: ModelCallReport): void;
  now(): number;
}

/**
 * The warm lifecycle: arm after a turn, fire on a wake, re-arm or stop.
 *
 * The POLICY, the durable row and the accounting are here so both backends
 * carry one implementation of them and differ only in the four seams above.
 */
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
   * Consider a warm for the request this turn ended on.
   *
   * Answers the armed time, or null when the policy declined — a caller that
   * wants to say why asks {@link warmingPlan} itself. A declined turn also
   * RETIRES whatever was armed before it: the request that just ran is the
   * newest evidence, and it says this prefix is not worth refreshing.
   *
   * `lastRequest` is the accumulator's own value (orchestrator's
   * `TurnAccumulator.lastRequest`), so the caller hands over what it has
   * rather than three fields it has to keep in step. Its body arrives as
   * `unknown` because a provider adapter reports whatever shape it sends; a
   * body that is not a JSON object cannot be stored or replayed, and warms
   * nothing.
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

  /**
   * Run the warm this wake was armed for, if it is still owed.
   *
   * Answers what was sent, so a caller can trace the phase: null when nothing
   * was due (the common case on a wake armed for something else).
   */
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
      // A FAILED WARM IS NOT RETRIED, and the row is retired BEFORE the throw
      // leaves. The chain is opportunistic — the vendor's own reading of a
      // missed refresh is one cache write on the next real turn, never a
      // retry — and a row left armed with a past `due_at` is the shape that
      // turns a rotated key or a 429 into one request per second: the fold
      // would answer due, the phase would fail, and the tick would re-arm from
      // the same fold. Retire first, then let the caller diagnose it once.
      this.seams.store.retire();

      throw toKinuError({ doing: 'warming the prompt-cache prefix', cause, otherwise: 'unavailable' });
    }

    if (outcome === null) {
      this.seams.store.retire();

      return null;
    }

    const spec = `${due.modelSpec.provider}/${due.modelSpec.modelId}`;
    this.seams.spend({ source: 'warming', usage: outcome.usage, spec, modelId: due.modelSpec.modelId });
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
