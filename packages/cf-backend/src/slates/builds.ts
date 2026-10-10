/**
 * Each slate's builds, per authority it was compiled with (`slateAuthority`): the last image that compiled, which that
 * authority keeps serving while a later edit does not, and the edit that did not, in the compiler's words. An image read
 * what its compiler's credential may read, so no other authority is ever served it. Kept in this object's storage, so an
 * eviction keeps both: the last working version is what its next activation serves, and the failure is what the agent's
 * next turn is told.
 */
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { Effect } from 'effect';
import * as v from 'valibot';
import { slateAuthority, type RawSqlExec, type SqlExec } from '@kinu.run/core';
import { KinuError, settle } from '@kinu.run/core/obs';
import type { SlateBuildFailure, SlateImage } from './resident';

export function initSlateBuildTable(execRaw: RawSqlExec): void {
  // Its rows were kept per slate alone, whoever compiled them: none is known to be whose, so none is kept.
  execRaw('DROP TABLE IF EXISTS slate_builds');
  execRaw(`CREATE TABLE IF NOT EXISTS slate_images (
    slate      TEXT NOT NULL,
    authority  TEXT NOT NULL,
    good_key   TEXT,
    good_image TEXT,
    failed_key TEXT,
    failure    TEXT,
    PRIMARY KEY (slate, authority)
  )`);
}

const SlateImageSchema = v.object({
  modules: v.record(v.string(), v.string()),
  client: v.optional(v.string()),
  shell: v.optional(v.string()),
});

const RowSchema = v.object({
  good_key: v.nullable(v.string()), good_image: v.nullable(v.string()), failed_key: v.nullable(v.string()), failure: v.nullable(v.string()),
});

/** A slate whose latest source does not build, and why. */
export interface FailingSlateBuild {
  readonly slate: string;
  readonly failure: string;
}

export class SlateBuilds {
  /** Read once per activation, as every model step asks; each write below keeps it current. */
  #failing: FailingSlateBuild[] | null = null;

  constructor(private readonly db: SqlExec) {}

  private row(slate: string, authority: string): v.InferOutput<typeof RowSchema> | null {
    const [row] = this.db.exec(`SELECT good_key, good_image, failed_key, failure FROM slate_images WHERE slate = ? AND authority = ?`, slate, authority).toArray();

    return row === undefined ? null : v.parse(RowSchema, row);
  }

  /** The source `key` compiled into `image` as `authority`: what the slate serves that authority from now on. */
  built(slate: string, authority: string, key: string, image: SlateImage): void {
    this.db.exec(
      `INSERT INTO slate_images (slate, authority, good_key, good_image) VALUES (?, ?, ?, ?)
       ON CONFLICT (slate, authority) DO UPDATE SET good_key = excluded.good_key, good_image = excluded.good_image, failed_key = NULL, failure = NULL`,
      slate, authority, key, JSON.stringify(image),
    );
    this.#failing = null;
  }

  /** The source `key` did not compile as `authority`. */
  failed(slate: string, authority: string, key: string, failure: string): void {
    this.db.exec(
      `INSERT INTO slate_images (slate, authority, failed_key, failure) VALUES (?, ?, ?, ?)
       ON CONFLICT (slate, authority) DO UPDATE SET failed_key = excluded.failed_key, failure = excluded.failure`,
      slate, authority, key, failure,
    );
    this.#failing = null;
  }

  /** The last source that built as `authority`, and its image; null before any did. */
  good(slate: string, authority: string): { readonly key: string; readonly image: SlateImage } | null {
    const row = this.row(slate, authority);

    return row?.good_key == null || row.good_image === null ? null : { key: row.good_key, image: v.parse(SlateImageSchema, JSON.parse(row.good_image)) };
  }

  /** Why the source `key` did not build as `authority`, when it is the one that last failed; null otherwise. */
  failure(slate: string, authority: string, key: string): string | null {
    const row = this.row(slate, authority);

    return row?.failed_key === key ? row.failure : null;
  }

  /** Every slate whose latest attempted build failed, as any authority, once each. */
  failing(): FailingSlateBuild[] {
    this.#failing ??= this.db.exec(`SELECT slate, MIN(failure) AS failure FROM slate_images WHERE failure IS NOT NULL GROUP BY slate ORDER BY slate`).toArray()
      .map((row) => v.parse(v.object({ slate: v.string(), failure: v.string() }), row));

    return this.#failing;
  }

  /** Its files changed since: whether it builds is not yet known. */
  changed(slates: readonly string[]): void {
    for (const slate of slates) this.db.exec(`UPDATE slate_images SET failed_key = NULL, failure = NULL WHERE slate = ?`, slate);

    if (slates.length > 0) this.#failing = null;
  }

  forget(slate: string): void {
    this.db.exec(`DELETE FROM slate_images WHERE slate = ?`, slate);
    this.#failing = null;
  }

  /** Every image a slate's last working build reads, kept past any process that ran it. */
  *retained(): Iterable<string> {
    for (const row of this.db.exec(`SELECT good_image FROM slate_images WHERE good_image IS NOT NULL`).toArray()) {
      const image = v.parse(SlateImageSchema, JSON.parse(v.parse(v.object({ good_image: v.string() }), row).good_image));

      yield* Object.values(image.modules);

      if (image.client !== undefined) yield image.client;

      if (image.shell !== undefined) yield image.shell;
    }
  }
}

/**
 * The image a slate runs from source `key` as `cred`: the one it builds with that credential, or, when that source does
 * not compile, the last that did with the same authority, with why the newer one did not. A source that fails again is
 * not compiled again. Refused when that authority never built it.
 */
export function slateImage(input: {
  readonly builds: SlateBuilds;
  readonly slate: string;
  readonly key: string;
  readonly cred: VfsCred;
  readonly build: () => Promise<SlateImage | SlateBuildFailure>;
}): Promise<{ readonly image: SlateImage; readonly key: string; readonly broken: string | null }> {
  return settle(Effect.gen(function* () {
    const { builds, slate, key } = input;
    const authority = slateAuthority(input.cred);
    const known = builds.failure(slate, authority, key);
    const built = known === null ? yield* Effect.promise(input.build) : { failed: known };

    if (!('failed' in built)) {
      builds.built(slate, authority, key, built);

      return { image: built, key, broken: null };
    }

    if (known === null) builds.failed(slate, authority, key, built.failed);
    const good = builds.good(slate, authority);

    if (good === null) return yield* new KinuError('bad_input', built.failed);

    return { image: good.image, key: good.key, broken: built.failed };
  }));
}
