/**
 * The two things that keep a conversation out of a fleet-wide analytics dataset.
 *
 * ## Why a digest rather than the identifier
 *
 * `analyticsDigest` exists because two of the identifiers an operational metric
 * most wants to be keyed by are USER TEXT wearing an identifier's clothes:
 *
 *   - A workspace id here is mission-derived. `identity/naming.ts` builds it from
 *     what the person asked for, so `my-personal-assistant-f0e4afa6` is a
 *     sentence they wrote, shortened. Writing it into a three-month-retention
 *     dataset that an admin UI renders publishes a fragment of their prompt.
 *   - An admin's email is the address itself.
 *
 * Neither can be dropped, because per-workspace sampling isolation and per-actor
 * audit are the whole point of AE's index column. So they are written as a
 * digest: the same input gives the same index value forever, a reader holding the
 * identifier can digest it and filter, and nobody holding the dataset can recover
 * an identifier they did not already have.
 *
 * It is NOT a secret-hiding primitive. The input space of workspace names is
 * small enough to enumerate, so this is not a substitute for authorization on the
 * read path. What it does is make the dataset carry no text that was never meant
 * to leave the conversation, which is the property the control plane needs in
 * order to render a blob without a redaction pass of its own.
 *
 * ## Why a name check rather than a value filter
 *
 * Core bans a reserved field NAME with a type, and a type is gone at runtime. The
 * runtime half here is deliberately not a value scrubber: a scrubber has to
 * recognise a secret, and the whole lesson of `RESERVED_LOG_FIELDS` is that you
 * cannot. So both writers into analytics publish from a CLOSED set of names — a
 * schema's slots and the sink's field allowlist — and `assertPublishableNames`
 * proves at module load that neither set contains a reserved one. A name that
 * cannot be declared is a value that cannot arrive.
 */
import { RESERVED_LOG_FIELDS } from '@kinu.run/core/obs';

/**
 * Refuse a set of publishable names that includes a reserved one, at module load
 * rather than at the write that would have published it.
 *
 * Called from the two places a name becomes publishable — a dataset's slot list
 * and the diagnostics sink's field allowlist — so the ban holds over both without
 * either knowing the other exists.
 */
export function assertPublishableNames(where: string, names: readonly string[]): void {
  for (const name of names) {
    if (RESERVED_LOG_FIELDS.some((field) => field === name)) {
      throw new RangeError(`${where}: "${name}" is a reserved field name and may not be published`);
    }
  }
}

/**
 * A stable, short, non-reversing digest of an identifier, as lowercase hex.
 *
 * FNV-1a over UTF-8, 64 bits as two 32-bit halves because JavaScript's bitwise
 * operators are 32-bit and a `BigInt` on a per-datapoint path is not worth its
 * allocation. Chosen over a cryptographic hash for one reason that matters more
 * than digest quality: `crypto.subtle.digest` is ASYNCHRONOUS, and every write on
 * this path is fire-and-forget from inside a turn, a route handler or a
 * `.catch()`. Making the index value await would turn a telemetry write into a
 * scheduling event in the middle of someone's turn.
 *
 * The empty string digests to the empty string rather than to FNV's offset basis,
 * so "no identifier" stays visibly absent instead of becoming one indistinguishable
 * bucket that looks like a real workspace.
 */
export function analyticsDigest(value: string): string {
  if (value === '') return '';
  const bytes = new TextEncoder().encode(value);
  let high = 0x811c9dc5;
  let low = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    low = Math.imul(low ^ bytes[i], 0x01000193) >>> 0;
    high = Math.imul(high ^ ((bytes[i] + i) & 0xff), 0x01000193) >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}
