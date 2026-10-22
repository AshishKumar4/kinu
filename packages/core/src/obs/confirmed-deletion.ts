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

/**
 * Deletes the object `object` opens, then reads it again through a new stub (`object` is called once for each): none of
 * its own data left is the deletion done, whatever came back. Where some is left, the deletion's own failure is the
 * reason, or, if it answered, the data it left. The read must create nothing it counts.
 */
export async function confirmedDeletion(object: () => Deletable, what: string): Promise<void> {
  return settle(Effect.gen(function* () {
    // Its outcome is the read's to say: an answer cut by the activation's end fails here with the storage gone.
    const deleting = yield* Effect.match(Effect.tryPromise({
      try: async () => object().destroy(), catch: (cause) => toKinuError({ doing: `deleting ${what}`, cause, otherwise: 'io' }),
    }), { onFailure: (failure): KinuError | null => failure, onSuccess: () => null });

    const held = yield* Effect.tryPromise({
      try: async () => object().remains(), catch: (cause) => toKinuError({ doing: `reading ${what} after its deletion`, cause, otherwise: 'io' }),
    });

    if (held === 0) return;

    if (deleting !== null) return yield* Effect.fail(deleting);

    return yield* Effect.fail(new KinuError('io', `${what} still holds ${String(held)} of its own after its deletion answered`));
  }));
}
