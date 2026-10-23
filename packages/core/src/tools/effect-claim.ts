/**
 * One effect receipt (design v2 §4): a once-only row `(actor, execution, normalized call, digest)` written before an
 * externally visible effect, in the store the effect commits to, and `started`, `settled(result)` or `indeterminate`.
 * A reset between effect and `tool_call_end` never replays the effect: a settled receipt answers a re-ask, and a started
 * one found again is indeterminate, refused explicitly. A call whose effect commits in another store (a workspace tool,
 * from an agent's isolate) keeps nothing here: that store's own receipt answers for it. Per-tool policy:
 * tools/registry.ts (`replay`).
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

/** The execution a receipt is kept under: `turnId` the durable turn id (the opening message), `runId` the run answering
 *  it. A recovery keeps both and finds its receipts; a Retry is another run and finds none of the last one's. */
export interface ReceiptExecution {
  readonly turnId: string;
  readonly runId: string;
}

/** A remote effect's receipt, as the store its effect commits to answers for it. An absent receipt never started, so a
 *  re-ask runs it; an indeterminate one started and never settled, so a re-ask is refused. */
export type RemoteReceipt =
  | { readonly status: 'settled'; readonly output: JsonValue }
  | { readonly status: 'indeterminate' };

export interface ToolEffectKey extends ReceiptExecution {
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
    run_id             TEXT NOT NULL,
    normalized_call_id TEXT NOT NULL,
    call_digest        TEXT NOT NULL,
    result_json        TEXT,
    PRIMARY KEY (actor_id, turn_id, run_id, normalized_call_id, call_digest)
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
    WHERE actor_id=${actorId} AND turn_id=${key.turnId} AND run_id=${key.runId}
      AND normalized_call_id=${key.callId} AND call_digest=${key.digest}
    LIMIT 1`[0];

  if (existing) {
    // Found started: whatever began it may or may not have taken effect.
    return existing.result_json === null ? { kind: 'indeterminate' } : { kind: 'settled', result: parseJsonValue(existing.result_json) };
  }

  void sql`INSERT OR IGNORE INTO tool_effect_claims
      (actor_id, turn_id, run_id, normalized_call_id, call_digest, result_json)
    VALUES (${actorId}, ${key.turnId}, ${key.runId}, ${key.callId}, ${key.digest}, ${null})`;

  return { kind: 'claimed' };
}

/** Settles a pending claim once; returns whether its result was recorded. */
export function settleToolEffect(
  sql: SqlExecutor, actor: ActorHandle, key: ToolEffectKey, result: string,
): boolean {
  actor.assertCurrent();

  return sql`UPDATE tool_effect_claims SET result_json=${result}
    WHERE actor_id=${actor.actorId} AND turn_id=${key.turnId} AND run_id=${key.runId}
      AND normalized_call_id=${key.callId} AND call_digest=${key.digest}
      AND result_json IS NULL RETURNING normalized_call_id`.length !== 0;
}

export interface EffectClaimDeps {
  readonly sql: SqlExecutor;
  /** Claim keys collide across actors of one workspace, so reads are scoped to this actor. */
  readonly actor: ActorHandle;
  /** Read at call time: a toolset is built once and used across many turns. */
  readonly execution: () => ReceiptExecution;
  /** Makes the call's part durable before it runs; absent where no model loop runs in this process (a workspace
   *  serving its agents' isolates), whose calls stream no part. */
  readonly durable?: (callId: string, signal?: AbortSignal) => Promise<void>;
  /** One synchronous commit in the store the receipt is kept in: a call whose effect is one local commit runs inside it
   *  with its receipt (design v2 §4), so its receipt is settled or absent, never started. */
  readonly transaction?: <A>(body: () => A) => A;
}

/** `args` is the call's input projected to JSON, as its digest binds it. */
function receiptKey(deps: Pick<EffectClaimDeps, 'execution'>, name: string, args: JsonValue, callId: string): ToolEffectKey {
  const { turnId, runId } = deps.execution();

  return { turnId, runId, callId, digest: argumentDigest({ tool: name, args }) };
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
        const key = receiptKey(deps, name, projectJsonValue({ value: input }), options.toolCallId);

        // A program's own call streams no part.
        if (options.messages.length > 0) await deps.durable?.(options.toolCallId, options.abortSignal);
        const { transaction } = deps;

        // One synchronous local commit: its receipt, effect and result commit as one, inside the call. A tool that says
        // its calls are transactional commits through the receipt it is handed; one that cannot says no such thing.
        if (transaction !== undefined && isTransactionalCall(entry, projectJsonValue({ value: input }))) {
          const receipt = new TransactionalReceipt((run) => transaction(() => committedOnce(deps, key, name, run)));

          return await execute(input, Object.assign({}, options, { [TRANSACTIONAL_RECEIPT_OPTION]: receipt }));
        }

        const claim = claimToolEffect(deps.sql, deps.actor, key);

        if (claim.kind === 'settled') return claim.result;

        if (claim.kind === 'indeterminate') return settle(Effect.fail(new KinuError('denied', indeterminateEffectMessage(name, key.callId))));
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
    + `it would have changed before calling it once more, then carry on with the task; the call is ${callId}.`;
}

/** What became of a call its turn lost, as a repair pairs it: answered, or refused as indeterminate. */
export type LostToolCall =
  | { readonly state: 'settled'; readonly result: JsonValue }
  | { readonly state: 'claimed'; readonly refusal: string };

/** Per execution: providers reuse call ids; an `<assignment>#<k>` round claims as its assignment. Null: this store holds
 *  no receipt of it, which the store its effect commits to may ({@link lostRemoteCall}). */
export function lostToolCall(
  sql: SqlExecutor, actor: ActorHandle, execution: ReceiptExecution, call: { readonly toolCallId: string; readonly toolName: string },
): LostToolCall | null {
  actor.assertCurrent();

  const [claimTurn = execution.turnId] = execution.turnId.split('#');

  const row = sql<{ result_json: string | null }>`SELECT result_json FROM tool_effect_claims
    WHERE actor_id=${actor.actorId} AND turn_id IN (${execution.turnId}, ${claimTurn}) AND run_id=${execution.runId}
      AND normalized_call_id=${call.toolCallId} LIMIT 1`[0];

  if (row === undefined) return null;

  return row.result_json === null
    ? { state: 'claimed', refusal: indeterminateEffectMessage(call.toolName, call.toolCallId) }
    : { state: 'settled', result: parseJsonValue(row.result_json) };
}

/**
 * A call this store holds no receipt of, from what the store its effect commits to said of it: its result, or the
 * indeterminate refusal for one it started and never settled. Never started there either (`'absent'`), it never ran:
 * the interruption.
 */
export function lostRemoteCall(answer: RemoteReceipt | 'absent', call: { readonly toolCallId: string; readonly toolName: string }): LostToolCall | null {
  if (answer === 'absent') return null;

  return answer.status === 'settled'
    ? { state: 'settled', result: answer.output }
    : { state: 'claimed', refusal: indeterminateEffectMessage(call.toolName, call.toolCallId) };
}

/** The receipts this store keeps for an execution's calls, as its isolate asks for the ones it holds none of. */
export function remoteReceipts(
  sql: SqlExecutor, actor: ActorHandle, execution: ReceiptExecution, callIds: readonly string[],
): ReadonlyMap<string, RemoteReceipt> {
  actor.assertCurrent();
  const receipts = new Map<string, RemoteReceipt>();

  const [claimTurn = execution.turnId] = execution.turnId.split('#');

  for (const callId of callIds) {
    const row = sql<{ result_json: string | null }>`SELECT result_json FROM tool_effect_claims
      WHERE actor_id=${actor.actorId} AND turn_id IN (${execution.turnId}, ${claimTurn}) AND run_id=${execution.runId}
        AND normalized_call_id=${callId} LIMIT 1`[0];

    if (row !== undefined) receipts.set(callId, row.result_json === null ? { status: 'indeterminate' } : { status: 'settled', output: parseJsonValue(row.result_json) });
  }

  return receipts;
}

/** A settled run's receipts go: nothing executes under it again, its close has paired every call it lost, and a Retry is
 *  another run. Its turn's other runs keep theirs. */
export function pruneTurnReceipts(sql: SqlExecutor, actor: ActorHandle, execution: ReceiptExecution): void {
  actor.assertCurrent();
  void sql`DELETE FROM tool_effect_claims
    WHERE actor_id=${actor.actorId} AND turn_id=${execution.turnId} AND run_id=${execution.runId}`;
}
