/**
 * Each slate's builds: the last image that compiled, which it keeps serving while a later edit does not, and the edit
 * that did not, in the compiler's words. Kept in this object's storage, so an eviction keeps both: the last working
 * version is what its next activation serves, and the failure is what the agent's next turn is told.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '@kinu.run/core';
import { KinuError, settle } from '@kinu.run/core/obs';
import type { SlateBuildFailure, SlateImage } from './resident';

export function initSlateBuildTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS slate_builds (
    slate      TEXT PRIMARY KEY,
    good_key   TEXT,
    good_image TEXT,
    failed_key TEXT,
    failure    TEXT
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
  constructor(private readonly db: SqlExec) {}

  private row(slate: string): v.InferOutput<typeof RowSchema> | null {
    const [row] = this.db.exec(`SELECT good_key, good_image, failed_key, failure FROM slate_builds WHERE slate = ?`, slate).toArray();

    return row === undefined ? null : v.parse(RowSchema, row);
  }

  /** The source `key` compiled into `image`: what the slate serves from now on. */
  built(slate: string, key: string, image: SlateImage): void {
    this.db.exec(
      `INSERT INTO slate_builds (slate, good_key, good_image) VALUES (?, ?, ?)
       ON CONFLICT (slate) DO UPDATE SET good_key = excluded.good_key, good_image = excluded.good_image, failed_key = NULL, failure = NULL`,
      slate, key, JSON.stringify(image),
    );
  }

  /** The source `key` did not compile. */
  failed(slate: string, key: string, failure: string): void {
    this.db.exec(
      `INSERT INTO slate_builds (slate, failed_key, failure) VALUES (?, ?, ?)
       ON CONFLICT (slate) DO UPDATE SET failed_key = excluded.failed_key, failure = excluded.failure`,
      slate, key, failure,
    );
  }

  /** The last source that built, and its image; null before any did. */
  good(slate: string): { readonly key: string; readonly image: SlateImage } | null {
    const row = this.row(slate);

    return row?.good_key == null || row.good_image === null ? null : { key: row.good_key, image: v.parse(SlateImageSchema, JSON.parse(row.good_image)) };
  }

  /** Why the source `key` did not build, when it is the one that last failed; null otherwise. */
  failure(slate: string, key: string): string | null {
    const row = this.row(slate);

    return row?.failed_key === key ? row.failure : null;
  }

  /** Every slate whose latest attempted build failed. */
  failing(): FailingSlateBuild[] {
    return this.db.exec(`SELECT slate, failure FROM slate_builds WHERE failure IS NOT NULL ORDER BY slate`).toArray()
      .map((row) => v.parse(v.object({ slate: v.string(), failure: v.string() }), row));
  }

  /** Its files changed since: whether it builds is not yet known. */
  changed(slates: readonly string[]): void {
    for (const slate of slates) this.db.exec(`UPDATE slate_builds SET failed_key = NULL, failure = NULL WHERE slate = ?`, slate);
  }

  forget(slate: string): void {
    this.db.exec(`DELETE FROM slate_builds WHERE slate = ?`, slate);
  }

  /** Every image a slate's last working build reads, kept past any process that ran it. */
  *retained(): Iterable<string> {
    for (const row of this.db.exec(`SELECT good_image FROM slate_builds WHERE good_image IS NOT NULL`).toArray()) {
      const image = v.parse(SlateImageSchema, JSON.parse(v.parse(v.object({ good_image: v.string() }), row).good_image));

      yield* Object.values(image.modules);

      if (image.client !== undefined) yield image.client;

      if (image.shell !== undefined) yield image.shell;
    }
  }
}

/**
 * The image a slate runs from source `key`: the one it builds, or, when that source does not compile, the last that did,
 * with why the newer one did not. A source that fails again is not compiled again. Refused only when nothing ever built.
 */
export function slateImage(input: {
  readonly builds: SlateBuilds;
  readonly slate: string;
  readonly key: string;
  readonly build: () => Promise<SlateImage | SlateBuildFailure>;
}): Promise<{ readonly image: SlateImage; readonly key: string; readonly broken: string | null }> {
  return settle(Effect.gen(function* () {
    const { builds, slate, key } = input;
    const known = builds.failure(slate, key);
    const built = known === null ? yield* Effect.promise(input.build) : { failed: known };

    if (!('failed' in built)) {
      builds.built(slate, key, built);

      return { image: built, key, broken: null };
    }

    if (known === null) builds.failed(slate, key, built.failed);
    const good = builds.good(slate);

    if (good === null) return yield* new KinuError('bad_input', built.failed);

    return { image: good.image, key: good.key, broken: built.failed };
  }));
}
