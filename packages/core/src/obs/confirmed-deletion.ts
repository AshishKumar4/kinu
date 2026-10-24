/**
 * An object's deletion, confirmed by a read of what it still holds (2026-10-22, option c of the account-deletion
 * review). A deletion that ends its object's activation (`ctx.abort`, as the Drive's objects and the Agents SDK's
 * `destroy` do) can cut its own answer on the way back: production cut 32 of 32 where local workerd delivered 60 of
 * 60, so neither the answer nor its failure says whether the storage went. Every such deletion goes through here.
 */
import { Effect } from 'effect';
import { settle } from './effect';
import { KinuError, toKinuError } from './error';

/** An object as its deletion reaches it: the deletion, and a read of how much of its own data it still holds, wherever
 *  it keeps it (its tables, and its KV entries if it has any: a SQLite object keeps those in `_cf_KV`). */
interface Deletable {
  destroy(): Promise<void>;
  remains(): Promise<number>;
}

/** What a deletion's object says of its own end, where it says anything certain. */
interface DeletionEnd {
  /** A failure the object raises only once its storage went (the Agents SDK aborts with `destroyed` after
   *  `deleteAll`): as the deletion's answer, or as the read's, it holds nothing. */
  readonly ended?: (failure: Error) => boolean;
  /** The deletion answers only once its storage went, as a workspace's does once its wipe returned. */
  readonly answerProves?: boolean;
}

/** A deletion's failure: what it threw, and whether that is its object's own end. */
interface DeletionFailure {
  readonly cause: unknown;
  readonly ended: boolean;
}

/** How a deletion was known to land: its answer, its object's own end, or a read of the object after it. */
export type DeletionProof = 'answered' | 'ended' | 'read';

/**
 * Deletes the object `object` opens. Where its answer or its failure says the storage went (`end`), that is the
 * deletion done; otherwise it reads the object again through a new stub (`object` is called once for each), which
 * starts it: none of its own data left is the deletion done, whatever came back. Where some is left, the deletion's own
 * failure is the reason, or, if it answered, the data it left. The read must create nothing it counts.
 */
export async function confirmedDeletion(object: () => Deletable, what: string, end: DeletionEnd = {}): Promise<DeletionProof> {
  return settle(Effect.gen(function* () {
    // The deletion's failure, as its cause and as the error it reads as; null where it answered.
    const deleting = yield* Effect.match(Effect.tryPromise({
      try: async () => object().destroy(), catch: (cause) => cause,
    }), { onFailure: (cause): DeletionFailure => ({ cause, ended: cause instanceof Error && end.ended?.(cause) === true }), onSuccess: () => null });

    if (deleting === null && end.answerProves === true) return 'answered' as const;

    if (deleting?.ended === true) return 'ended' as const;

    // Its outcome is the read's to say: an answer cut by the activation's end fails here with the storage gone.
    const held = yield* Effect.tryPromise({ try: async () => object().remains(), catch: (cause) => cause }).pipe(
      Effect.catch((cause) => (cause instanceof Error && end.ended?.(cause) === true
        ? Effect.succeed(0)
        : Effect.fail(toKinuError({ doing: `reading ${what} after its deletion`, cause, otherwise: 'io' })))),
    );

    if (held === 0) return 'read' as const;

    if (deleting !== null) return yield* Effect.fail(toKinuError({ doing: `deleting ${what}`, cause: deleting.cause, otherwise: 'io' }));

    return yield* Effect.fail(new KinuError('io', `${what} still holds ${String(held)} of its own after its deletion answered`));
  }));
}
