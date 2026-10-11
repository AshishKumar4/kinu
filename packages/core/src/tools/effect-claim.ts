/**
 * One effect receipt (design v2 §4): a once-only row `(actor, canonical turn, normalized call, digest)` written before an
 * externally visible effect, in the store the effect commits to, and `started`, `settled(result)` or `indeterminate`.
 * A reset between effect and `tool_call_end` never replays the effect: a settled receipt answers a re-ask, and a started
 * one found again is indeterminate, refused explicitly. A call whose effect commits in another store (a workspace tool,
 * from an agent's isolate) re-asks that store, whose own receipt answers it. Per-tool policy: tools/registry.ts (`replay`).
 */

import type { ToolSet } from 'ai';
import { argumentDigest } from '../safety/argument-digest';
import { Effect } from 'effect';
import { KinuError, settle } from '../obs/index';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { parseJsonValue, projectJsonValue, type JsonValue } from '../utils/json';
import { replayPolicyFor } from './registry';
import { isTransactionalCall, TRANSACTIONAL_RECEIPT_OPTION, TransactionalReceipt, type ReceiptCommit } from './transactional-receipt';

/** `turnId` is the durable turn id (the opening message), not the per-attempt run id, so a recovery matches. */
export interface ToolEffectKey {
  readonly turnId: string;
  /** The provider's id for this call, normalized by the caller. */
  readonly callId: string;
  /** Tool name + canonical arguments, bound together. */
  readonly digest: string;
}

/** `result` is the settled attempt's output, which a replay must return. */
export type ToolEffectClaim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'indeterminate' }
  | { readonly kind: 'settled'; readonly result: JsonValue };

export function initToolEffectClaimTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS tool_effect_claims (
    actor_id           TEXT NOT NULL,
    turn_id            TEXT NOT NULL,
    normalized_call_id TEXT NOT NULL,
    call_digest        TEXT NOT NULL,
    result_json        TEXT,
    status             TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'settled', 'indeterminate')),
    PRIMARY KEY (actor_id, turn_id, normalized_call_id, call_digest)
  )`);
  // Recovery reads only what never settled; the primary key leads with the turn, so it scanned every settled claim.
  execRaw(`CREATE INDEX IF NOT EXISTS tool_effect_claims_pending
    ON tool_effect_claims (actor_id, turn_id, normalized_call_id) WHERE result_json IS NULL`);
}

/** Read first, then insert, with no await between: only the prior read separates "just claimed" from
 *  "claimed and never settled"; one tick is atomic on both backends. */
export function claimToolEffect(
  sql: SqlExecutor, actor: ActorHandle, key: ToolEffectKey,
): ToolEffectClaim {
  actor.assertCurrent();
  const actorId = actor.actorId;

  const existing = sql<{ result_json: string | null }>`
    SELECT result_json FROM tool_effect_claims
    WHERE actor_id=${actorId} AND turn_id=${key.turnId}
      AND normalized_call_id=${key.callId} AND call_digest=${key.digest}
    LIMIT 1`[0];

  if (existing) {
    if (existing.result_json !== null) return { kind: 'settled', result: parseJsonValue(existing.result_json) };

    // Found started: whatever began it may or may not have taken effect.
    void sql`UPDATE tool_effect_claims SET status = 'indeterminate'
      WHERE actor_id=${actorId} AND turn_id=${key.turnId} AND normalized_call_id=${key.callId} AND call_digest=${key.digest}`;

    return { kind: 'indeterminate' };
  }

  void sql`INSERT OR IGNORE INTO tool_effect_claims
      (actor_id, turn_id, normalized_call_id, call_digest, result_json)
    VALUES (${actorId}, ${key.turnId}, ${key.callId}, ${key.digest}, ${null})`;

  return { kind: 'claimed' };
}

/** Settles a pending claim once; returns whether its result was recorded. */
export function settleToolEffect(
  sql: SqlExecutor, actor: ActorHandle, key: ToolEffectKey, result: string,
): boolean {
  actor.assertCurrent();

  return sql`UPDATE tool_effect_claims SET result_json=${result}, status = 'settled'
    WHERE actor_id=${actor.actorId} AND turn_id=${key.turnId}
      AND normalized_call_id=${key.callId} AND call_digest=${key.digest}
      AND result_json IS NULL RETURNING normalized_call_id`.length !== 0;
}

export interface EffectClaimDeps {
  readonly sql: SqlExecutor;
  /** Claim keys collide across actors of one workspace, so reads are scoped to this actor. */
  readonly actor: ActorHandle;
  /** Read at call time: a toolset is built once and used across many turns. */
  readonly turnId: () => string;
  readonly durable: (callId: string, signal?: AbortSignal) => Promise<void>;
  /** One synchronous commit in the store the receipt is kept in: a call whose effect is one local commit runs inside it
   *  with its receipt (design v2 §4), so its receipt is settled or absent, never started. */
  readonly transaction?: <A>(body: () => A) => A;
  /** Tools whose effect commits in another store, whose own receipt answers a re-ask: a started receipt here re-asks
   *  it under the same call, rather than refusing. Cloud only: an agent's isolate runs its workspace's tools there; the
   *  CLI runs every tool in the process that keeps its receipt. */
  readonly elsewhere?: (name: string) => boolean;
}

/** Wraps every `claimed` tool in its receipt; `safe` tools pass through untouched. Anything not proven safe is claimed. */
export function withEffectReceipt(
  tools: ToolSet,
  deps: EffectClaimDeps,
  opts?: { readonly safe?: ReadonlySet<string> },
): ToolSet {
  // Built by assignment so the compiler checks every entry; `fromEntries` would need an unchecked cast.
  const claimed: ToolSet = {};

  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute;

    if (replayPolicyFor(name) === 'safe' || opts?.safe?.has(name) === true || !execute) {
      claimed[name] = entry;
      continue;
    }

    claimed[name] = {
      ...entry,
      execute: async (input, options) => {
        const key: ToolEffectKey = {
          turnId: deps.turnId(),
          callId: options.toolCallId,
          digest: argumentDigest({ tool: name, args: projectJsonValue({ value: input }) }),
        };

        // A program's own call streams no part.
        if (options.messages.length > 0) await deps.durable(options.toolCallId, options.abortSignal);
        const { transaction } = deps;

        // One synchronous local commit: its receipt, effect and result commit as one, inside the call.
        if (transaction !== undefined && isTransactionalCall(entry, projectJsonValue({ value: input }))) {
          const receipt = new TransactionalReceipt((run) => transaction(() => committedOnce(deps, key, name, run)));
          const output = await execute(input, Object.assign({}, options, { [TRANSACTIONAL_RECEIPT_OPTION]: receipt }));

          // A wrapper that did not hand the receipt on ran it outside: its result is recorded after, as any call's is.
          if (!receipt.committed) settleToolEffect(deps.sql, deps.actor, key, JSON.stringify(projectJsonValue({ value: output })));

          return output;
        }

        const claim = claimToolEffect(deps.sql, deps.actor, key);

        if (claim.kind === 'settled') return claim.result;

        // Its effect's own store knows what became of it: asked again under the same call, its receipt answers.
        if (claim.kind === 'indeterminate' && deps.elsewhere?.(name) !== true) return settle(Effect.fail(new KinuError('denied', indeterminateEffectMessage(name, key.callId))));
        const output = await execute(input, options);
        // Durable before published: the row must exist before the caller reads this value.
        settleToolEffect(
          deps.sql, deps.actor, key, JSON.stringify(projectJsonValue({ value: output })),
        );

        return output;
      },
    };
  }

  return claimed;
}

/** Inside the transaction: a settled receipt answers; a started one cannot exist for a transactional effect, which rolls
 *  back with it, and is refused if found; else the receipt, the effect and its result are written together. */
function committedOnce(deps: EffectClaimDeps, key: ToolEffectKey, name: string, run: () => JsonValue): ReceiptCommit {
  const claim = claimToolEffect(deps.sql, deps.actor, key);

  if (claim.kind === 'settled') return { kind: 'answered', output: claim.result };

  if (claim.kind === 'indeterminate') return { kind: 'refused', failure: new KinuError('denied', indeterminateEffectMessage(name, key.callId)) };
  const output = run();

  settleToolEffect(deps.sql, deps.actor, key, JSON.stringify(projectJsonValue({ value: output })));

  return { kind: 'answered', output };
}

function indeterminateEffectMessage(name: string, callId: string): string {
  return `${name} was already started once in this turn and its outcome was never recorded, `
    + `so it may or may not have taken effect. It is not being run again. Check the state `
    + `it would have changed before calling it once more; the call is ${callId}.`;
}

export type LostToolCall =
  | { readonly state: 'settled'; readonly result: JsonValue }
  | { readonly state: 'claimed'; readonly refusal: string };

/** Per turn (providers reuse call ids); an `<assignment>#<k>` round claims as its assignment. */
export function lostToolCall(
  sql: SqlExecutor, actor: ActorHandle, turnId: string, call: { readonly toolCallId: string; readonly toolName: string },
): LostToolCall | null {
  actor.assertCurrent();
  const [claimTurn = turnId] = turnId.split('#');

  const row = sql<{ result_json: string | null }>`SELECT result_json FROM tool_effect_claims
    WHERE actor_id=${actor.actorId} AND turn_id IN (${turnId}, ${claimTurn}) AND normalized_call_id=${call.toolCallId} LIMIT 1`[0];

  if (row === undefined) return null;

  return row.result_json === null
    ? { state: 'claimed', refusal: indeterminateEffectMessage(call.toolName, call.toolCallId) }
    : { state: 'settled', result: parseJsonValue(row.result_json) };
}
