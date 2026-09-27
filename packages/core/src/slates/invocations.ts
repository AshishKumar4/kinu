import { InvocationId, ReceiptId } from '@agent-core/core';
import {
  canonicalSlateInvocationRequest, SlateEffectContext, SlateInvocationSeam,
  type SlateId, type SlateInvocationRequest, type SlateInvocationResult,
} from '@agent-core/core/slates';
import * as v from 'valibot';
import { Effect } from 'effect';
import { CODE_WORK_DID_NOT_START, KinuError } from '../obs/error';
import { attempt, settle } from '../obs/effect';
import type { SqlExec } from '../types/primitives';
import { nanoid } from '../utils/nanoid';

const InvocationRow = v.object({
  request: v.string(), attempt: v.number(), owner_epoch: v.string(),
  state: v.picklist(['prepared', 'running', 'succeeded', 'failed', 'indeterminate']),
});

const ReceiptRow = v.object({
  id: v.string(), invocationId: v.string(), attempt: v.number(),
  outcome: v.picklist(['succeeded', 'failed', 'indeterminate']),
  error: v.nullable(v.string()), finishedAt: v.number(),
});

export interface SlateInvocationAuthority {
  admit(request: SlateInvocationRequest): Promise<void>;
  assertCurrent(): void;
}

export class SqliteSlateInvocations extends SlateInvocationSeam {
  constructor(
    private readonly db: SqlExec,
    private readonly atomic: <Result>(operation: () => Result) => Result,
    private readonly epoch: string,
    private readonly authority: SlateInvocationAuthority,
  ) { super(); }

  async prepare(request: SlateInvocationRequest): Promise<InvocationId> {
    await this.authority.admit(request);
    this.authority.assertCurrent();
    const id = new InvocationId(nanoid());
    this.db.exec(`INSERT INTO slate_invocations (id, slate_id, request, attempt, owner_epoch, state)
      VALUES (?, ?, ?, 0, ?, 'prepared')`, id.value, request.slateId.value,
    new TextDecoder().decode(canonicalSlateInvocationRequest(request)), this.epoch);

    return id;
  }

  invoke<Result>(request: SlateInvocationRequest, id: InvocationId, effect: (context: SlateEffectContext) => Promise<Result>): Promise<SlateInvocationResult<Result>> {
    return settle(this.execute(request, id, effect));
  }

  reconcile<Result>(request: SlateInvocationRequest, id: InvocationId, effect: (context: SlateEffectContext) => Promise<Result>): Promise<SlateInvocationResult<Result>> {
    return settle(this.execute(request, id, effect));
  }

  receipts(id: SlateId) {
    return this.db.exec(`SELECT r.id, r.invocation_id AS invocationId, r.attempt, r.outcome, r.error, r.finished_at AS finishedAt
      FROM slate_receipts r JOIN slate_invocations i ON i.id = r.invocation_id WHERE i.slate_id = ? ORDER BY r.finished_at, r.attempt`, id.value)
      .toArray().map((row) => v.parse(ReceiptRow, row));
  }

  private execute<Result>(
    request: SlateInvocationRequest,
    id: InvocationId,
    effect: (context: SlateEffectContext) => Promise<Result>,
  ): Effect.Effect<SlateInvocationResult<Result>, KinuError> {
    return Effect.gen({ self: this }, function* () {
      this.authority.assertCurrent();

      const claimed = this.atomic((): number | KinuError => {
        const stored = this.db.exec('SELECT request, attempt, owner_epoch, state FROM slate_invocations WHERE id = ?', id.value).toArray()[0];

        if (stored === undefined) return new KinuError('missing', 'Slate invocation was not prepared');
        const row = v.parse(InvocationRow, stored);

        if (row.request !== new TextDecoder().decode(canonicalSlateInvocationRequest(request))) {
          return new KinuError('denied', 'Slate invocation does not match its admitted intent');
        }

        if (row.state === 'running' && row.owner_epoch === this.epoch) {
          return new KinuError('denied', 'Slate invocation already has a live effect');
        }

        const next = row.attempt + 1;
        this.db.exec("UPDATE slate_invocations SET attempt = ?, owner_epoch = ?, state = 'running' WHERE id = ?", next, this.epoch, id.value);

        return next;
      });

      if (claimed instanceof KinuError) return yield* claimed;

      const receiptId = new ReceiptId(nanoid());
      const context = new SlateEffectContext(id, 0, claimed, `slate:${id.value}:0`);

      const ran = yield* Effect.match(attempt({ doing: `Slate ${request.operation}`, otherwise: 'io' }, () => effect(context)), {
        onSuccess: (value) => ({ result: { outcome: 'succeeded', receiptId, value } satisfies SlateInvocationResult<Result>, failure: null }),
        onFailure: (error) => ({
          result: { outcome: CODE_WORK_DID_NOT_START[error.code] ? 'failed' : 'indeterminate', receiptId } satisfies SlateInvocationResult<Result>,
          failure: error.message,
        }),
      });

      const recorded = this.atomic((): KinuError | null => {
        const changed = this.db.exec(`UPDATE slate_invocations SET state = ?
          WHERE id = ? AND attempt = ? AND owner_epoch = ? AND state = 'running' RETURNING id`,
        ran.result.outcome, id.value, claimed, this.epoch).toArray();

        if (changed.length === 0) return new KinuError('denied', 'Slate invocation ownership changed before its receipt');
        this.db.exec(`INSERT INTO slate_receipts (id, invocation_id, attempt, outcome, error, finished_at)
          VALUES (?, ?, ?, ?, ?, ?)`, receiptId.value, id.value, claimed, ran.result.outcome, ran.failure, Date.now());

        return null;
      });

      if (recorded !== null) return yield* recorded;
      this.authority.assertCurrent();

      return ran.result;
    });
  }
}
