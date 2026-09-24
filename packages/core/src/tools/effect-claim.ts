/**
 * Tool-effect claims: a once-only row written before an externally visible effect and settled after it,
 * so a reset between effect and `tool_call_end` never replays the effect. Per-tool policy: tools/registry.ts (`replay`).
 */

import type { ToolSet } from 'ai';
import { argumentDigest } from '../safety/argument-digest';
import { KinuError } from '../obs/index';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { parseJsonValue, projectJsonValue, type JsonValue } from '../utils/json';
import { replayPolicyFor } from './registry';

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
    PRIMARY KEY (actor_id, turn_id, normalized_call_id, call_digest)
  )`);
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
    return existing.result_json === null
      ? { kind: 'indeterminate' }
      : { kind: 'settled', result: parseJsonValue(existing.result_json) };
  }

  void sql`INSERT OR IGNORE INTO tool_effect_claims
      (actor_id, turn_id, normalized_call_id, call_digest, result_json)
    VALUES (${actorId}, ${key.turnId}, ${key.callId}, ${key.digest}, ${null})`;

  return { kind: 'claimed' };
}

/** Guarded on the result still being absent, so a duplicate settle cannot overwrite the first outcome. */
export function settleToolEffect(
  sql: SqlExecutor, actor: ActorHandle, key: ToolEffectKey, result: string,
): void {
  actor.assertCurrent();
  void sql`UPDATE tool_effect_claims SET result_json=${result}
    WHERE actor_id=${actor.actorId} AND turn_id=${key.turnId}
      AND normalized_call_id=${key.callId} AND call_digest=${key.digest}
      AND result_json IS NULL`;
}

export interface EffectClaimDeps {
  readonly sql: SqlExecutor;
  /** Claim keys collide across actors of one workspace, so reads are scoped to this actor. */
  readonly actor: ActorHandle;
  /** Read at call time: a toolset is built once and used across many turns. */
  readonly turnId: () => string;
}

/** Wraps every `claimed` tool; `safe` tools pass through untouched. Anything not proven safe is claimed. */
export function withEffectClaims(
  tools: ToolSet,
  deps: EffectClaimDeps,
  options?: { readonly safe?: ReadonlySet<string> },
): ToolSet {
  // Built by assignment so the compiler checks every entry; `fromEntries` would need an unchecked cast.
  const claimed: ToolSet = {};

  for (const [name, entry] of Object.entries(tools)) {
    claimed[name] = replayPolicyFor(name) === 'safe' || options?.safe?.has(name) === true
      ? entry
      : withEffectClaim(name, entry, deps);
  }

  return claimed;
}

function withEffectClaim(name: string, entry: ToolSet[string], deps: EffectClaimDeps): ToolSet[string] {
  const execute = entry.execute;

  if (!execute) return entry;

  return {
    ...entry,
    execute: async (input, options) => {
      const key: ToolEffectKey = {
        turnId: deps.turnId(),
        callId: options.toolCallId,
        digest: argumentDigest({ tool: name, args: projectJsonValue({ value: input }) }),
      };

      const claim = claimToolEffect(deps.sql, deps.actor, key);

      if (claim.kind === 'settled') return claim.result;

      if (claim.kind === 'indeterminate') throw indeterminateEffect(name, key);
      const output = await execute(input, options);
      // Durable before published: the row must exist before the caller reads this value.
      settleToolEffect(
        deps.sql, deps.actor, key, JSON.stringify(projectJsonValue({ value: output })),
      );

      return output;
    },
  };
}

/** `denied`: a replay could repeat an effect, so the harness declined. */
function indeterminateEffect(name: string, key: ToolEffectKey): KinuError {
  return new KinuError(
    'denied',
    `${name} was already started once in this turn and its outcome was never recorded, `
    + `so it may or may not have taken effect. It is not being run again. Check the state `
    + `it would have changed before calling it once more; the call is ${key.callId}.`,
  );
}
