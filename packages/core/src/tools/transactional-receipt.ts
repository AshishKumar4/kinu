import type { Tool, ToolExecutionOptions } from 'ai';
import * as v from 'valibot';
import { Effect } from 'effect';
import { settleSync, type KinuError } from '../obs/index';
import type { JsonValue } from '../utils/json';

/** What one transaction answered: the call's result, a settled receipt's or its own, or the refusal of a receipt found
 *  started. */
export type ReceiptCommit = { readonly kind: 'answered'; readonly output: JsonValue } | { readonly kind: 'refused'; readonly failure: KinuError };

/**
 * A tool's own word on which of its calls are one synchronous local commit (design v3 D): a property of the tool, so it
 * rides every wrapper that spreads the tool, read by its receipt before it starts one.
 */
export const TRANSACTIONAL_CALL = 'kinuTransactional';

export type TransactionalCall = (input: JsonValue) => boolean;

const TransactionalToolSchema = v.object({
  [TRANSACTIONAL_CALL]: v.custom<TransactionalCall>((value) => typeof value === 'function'),
});

/** Whether this call of `entry` is one synchronous local commit. */
export function isTransactionalCall(entry: Tool, input: JsonValue): boolean {
  const parsed = v.safeParse(TransactionalToolSchema, entry);

  return parsed.success && parsed.output[TRANSACTIONAL_CALL](input);
}

/**
 * The receipt's transaction, handed to a transactional call through its options: `commit` runs the call's effect inside
 * one synchronous commit with its receipt and result (design v2 §4), so the receipt is settled or absent, never started.
 */
export class TransactionalReceipt {
  #committed = false;

  constructor(private readonly commitWith: (run: () => JsonValue) => ReceiptCommit) {}

  commit(run: () => JsonValue): JsonValue {
    this.#committed = true;
    const committed = this.commitWith(run);

    if (committed.kind === 'refused') return settleSync(Effect.fail(committed.failure));

    return committed.output;
  }

  /** Whether the call ran through it: one a wrapper did not hand its options on to settles its receipt after. */
  get committed(): boolean {
    return this.#committed;
  }
}

export const TRANSACTIONAL_RECEIPT_OPTION = 'kinuReceipt';

const ReceiptOptionsSchema = v.object({ [TRANSACTIONAL_RECEIPT_OPTION]: v.optional(v.instance(TransactionalReceipt)) });

export function readTransactionalReceipt(options: ToolExecutionOptions<unknown> | undefined): TransactionalReceipt | undefined {
  const parsed = v.safeParse(ReceiptOptionsSchema, options);

  return parsed.success ? parsed.output[TRANSACTIONAL_RECEIPT_OPTION] : undefined;
}
