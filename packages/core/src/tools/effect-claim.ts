/**
 * Tool-effect claims — the once-only boundary in front of a tool whose effects
 * leave this process.
 *
 * THE WINDOW THIS CLOSES. A turn's durable record of a tool call is written
 * after the fact: the `tool_call_end` run event and the assistant message that
 * carries the call both land once the call is over. So a reset between the
 * effect and that record — an eviction, a code update, a crash — leaves NO
 * trace that the call was ever attempted, and recovery replays the provider
 * response that asked for it. A payment, a deploy, an email, a `git push`
 * happens twice, and nothing in the workspace can tell that it did.
 *
 * WHAT THIS IS. One row, written BEFORE the effect and completed after it,
 * keyed by the identity a reset preserves: the run, the provider's id for the
 * call, and a digest of what was called with what. Three answers, from one
 * read:
 *
 *   claimed        nobody has run this call. Run it.
 *   settled        it ran, and its output is the row. Hand that back and run
 *                  nothing.
 *   indeterminate  it started and never finished. The effect may or may not
 *                  have landed, and no third party can be asked, so the one
 *                  answer that is never wrong is to say exactly that.
 *
 * WHAT THIS IS NOT. Not a log — `tool_call_end` is still the only completion
 * event, and nothing here is emitted. Not a queue — nothing sweeps these rows,
 * nothing re-drives them, and a row is never the reason work runs. Not a
 * status table — a row's whole state is whether its result is there yet.
 *
 * Which tools go through it is declared once, per capability, in
 * tools/registry.ts (`replay`). A name that table does not declare resolves to
 * `claimed`, so nothing is opted out by omission.
 */

import type { ToolSet } from 'ai';
import { argumentDigest } from '../safety/argument-digest';
import { refusalText } from '../execution/exec-result';
import { KinuError } from '../obs/index';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { parseJsonValue, projectJsonValue, type JsonValue } from '../utils/json';
import { replayPolicyFor } from './registry';

/**
 * The identity of one tool call, as it survives a reset.
 *
 * `turnId` is the DURABLE turn identity — the id of the message the turn opened
 * on — and not the run id, which is minted per attempt (`run-${nanoid()}` in
 * both backends' turn entry). A recovery re-drives the turn under a NEW run id,
 * so a run-scoped key could never match the attempt it exists to catch, and the
 * table would close no window at all. The durable turn id is the same on both
 * attempts, and so is the provider's id for the call, because the assistant
 * message carrying it is what gets replayed.
 */
export interface ToolEffectKey {
  /** The durable id of the message the calling turn opened on. */
  readonly turnId: string;
  /** The provider's id for this call, normalized by the caller. */
  readonly callId: string;
  /** Tool name + canonical arguments, bound together. */
  readonly digest: string;
}

/** What a claim read establishes about a call. `result` is the output the
 *  settled attempt produced, which is what a replay must return. */
export type ToolEffectClaim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'indeterminate' }
  | { readonly kind: 'settled'; readonly result: JsonValue };

export function initToolEffectClaimTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS tool_effect_claims (
    turn_id            TEXT NOT NULL,
    normalized_call_id TEXT NOT NULL,
    call_digest        TEXT NOT NULL,
    result_json        TEXT,
    PRIMARY KEY (turn_id, normalized_call_id, call_digest)
  )`);
}

/**
 * Claim one call's effect, or report what a previous attempt already did with
 * it.
 *
 * The read comes FIRST and that order is the mechanism: an insert cannot
 * distinguish "I just claimed this" from "somebody claimed it and never
 * settled" — both leave one row with no result. The prior read is the only
 * observation that separates them, and the pair is one event-loop tick with no
 * await in it, which is what makes it atomic on both backends (a Durable
 * Object serializes storage access; a local workspace holds the driver lease).
 */
export function claimToolEffect(sql: SqlExecutor, key: ToolEffectKey): ToolEffectClaim {
  const existing = sql<{ result_json: string | null }>`
    SELECT result_json FROM tool_effect_claims
    WHERE turn_id=${key.turnId} AND normalized_call_id=${key.callId} AND call_digest=${key.digest}
    LIMIT 1`[0];
  if (existing) {
    return existing.result_json === null
      ? { kind: 'indeterminate' }
      : { kind: 'settled', result: parseJsonValue(existing.result_json) };
  }
  void sql`INSERT OR IGNORE INTO tool_effect_claims (turn_id, normalized_call_id, call_digest, result_json)
    VALUES (${key.turnId}, ${key.callId}, ${key.digest}, ${null})`;
  return { kind: 'claimed' };
}

/** Record what the claimed call produced. Guarded on the result still being
 *  absent, so a duplicate settle cannot overwrite the first outcome. */
export function settleToolEffect(sql: SqlExecutor, key: ToolEffectKey, result: string): void {
  void sql`UPDATE tool_effect_claims SET result_json=${result}
    WHERE turn_id=${key.turnId} AND normalized_call_id=${key.callId} AND call_digest=${key.digest}
      AND result_json IS NULL`;
}

/** Drop one turn's claims. Called only once that turn's answer is durably
 *  persisted: until then the claims are the only thing standing between a
 *  recovery and a repeated effect. */
export function releaseTurnEffectClaims(sql: SqlExecutor, turnId: string): void {
  void sql`DELETE FROM tool_effect_claims WHERE turn_id=${turnId}`;
}

export interface EffectClaimDeps {
  readonly sql: SqlExecutor;
  /** The durable id of the message the live turn opened on, read at CALL time:
   *  a toolset is built once and used across many turns. */
  readonly turnId: () => string;
}

/**
 * Put every `claimed` tool of a set behind its claim. `safe` tools are handed
 * back untouched — no wrapper, no row, no cost.
 */
export function withEffectClaims(tools: ToolSet, deps: EffectClaimDeps): ToolSet {
  // Built by assignment rather than `Object.fromEntries(...) as ToolSet`.
  // `fromEntries` erases the value type, so the cast that followed it was
  // load-bearing and unchecked — it would have accepted a wrapper that had
  // stopped being a tool. Assigning into a declared ToolSet makes the compiler
  // check every entry against the surface it is going into.
  const claimed: ToolSet = {};
  for (const [name, entry] of Object.entries(tools)) {
    claimed[name] = replayPolicyFor(name) === 'safe'
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
      const claim = claimToolEffect(deps.sql, key);
      if (claim.kind === 'settled') return claim.result;
      if (claim.kind === 'indeterminate') return refusalText(indeterminateEffect(name, key));
      const output = await execute(input, options);
      // Durable before published: the caller reads this value only after the
      // row that makes a replay return it instead of running the tool again.
      settleToolEffect(deps.sql, key, JSON.stringify(projectJsonValue({ value: output })));
      return output;
    },
  };
}

/** `denied`, not `io` or `unavailable`: nothing broke and nothing is waiting to
 *  become available. This is a decision — the harness established that running
 *  the call again could repeat an effect, and declined. */
function indeterminateEffect(name: string, key: ToolEffectKey): KinuError {
  return new KinuError(
    'denied',
    `${name} was already started once in this turn and its outcome was never recorded, `
    + `so it may or may not have taken effect. It is not being run again. Check the state `
    + `it would have changed before calling it once more; the call is ${key.callId}.`,
  );
}
