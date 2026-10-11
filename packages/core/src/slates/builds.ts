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
import type { RawSqlExec, SqlExec } from '../types/primitives';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
import { slateAuthority } from './authority';

/**
 * A workspace path outside the slate's own tree a compile looked at: a file it read, or a path it found missing (a
 * module or package it probed for), which a later creation under it can change.
 */
export interface SlateBuildRead {
  readonly path: string;
  readonly missing: boolean;
}

/** A compiled slate: each module's content digest, the client bundle and page shell when it has a browser surface. */
export interface SlateImage {
  readonly modules: Readonly<Record<string, string>>;
  readonly client?: string;
  readonly shell?: string;
  /** What the compile looked at outside the slate's own tree; kept beside the image, not in it. */
  readonly inputs?: readonly SlateBuildRead[];
}

/** What a build that did not compile says: the compiler's own words, file and line among them. */
export interface SlateBuildFailure {
  readonly failed: string;
  /** What the compile looked at before it failed, a missing import among them. */
  readonly inputs?: readonly SlateBuildRead[];
  /**
   * Its resolution went through links, or a lookup the namespace refused, so a write that would make it build may
   * touch nothing it recorded: it is reported, and never stands in for compiling the same source again.
   */
  readonly unobserved?: true;
}

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
    generation INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (slate, authority)
  )`);
  // What each authority's builds of a slate looked at outside its tree: the last that built, and any failed since.
  execRaw(`CREATE TABLE IF NOT EXISTS slate_build_inputs (
    slate     TEXT NOT NULL,
    authority TEXT NOT NULL,
    path      TEXT NOT NULL,
    missing   INTEGER NOT NULL,
    PRIMARY KEY (slate, authority, path)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS slate_build_inputs_path ON slate_build_inputs (path)');
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

/** Every directory above `path`, nearest first. */
function ancestors(path: string): string[] {
  const above: string[] = [];

  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) above.push(path.slice(0, at));

  return path.startsWith('/') && path !== '/' ? [...above, '/'] : above;
}

export class SlateBuilds {
  /** Read once per activation per authority, as every model step asks; each write below keeps it current. */
  readonly #failing = new Map<string, FailingSlateBuild[]>();

  constructor(private readonly db: SqlExec) {}

  private row(slate: string, authority: string): v.InferOutput<typeof RowSchema> | null {
    const [row] = this.db.exec(`SELECT good_key, good_image, failed_key, failure FROM slate_images WHERE slate = ? AND authority = ?`, slate, authority).toArray();

    return row === undefined ? null : v.parse(RowSchema, row);
  }

  /** The source `key` compiled into `image` as `authority`: what the slate serves that authority from now on, and all
   *  its next build is stale by. */
  built(slate: string, authority: string, key: string, image: SlateImage): void {
    const { inputs = [], ...kept } = image;

    this.db.exec(
      `INSERT INTO slate_images (slate, authority, good_key, good_image) VALUES (?, ?, ?, ?)
       ON CONFLICT (slate, authority) DO UPDATE SET good_key = excluded.good_key, good_image = excluded.good_image, failed_key = NULL, failure = NULL`,
      slate, authority, key, JSON.stringify(kept),
    );
    this.db.exec(`DELETE FROM slate_build_inputs WHERE slate = ? AND authority = ?`, slate, authority);
    this.looked(slate, authority, inputs);
    this.#failing.clear();
  }

  /** The source `key` did not compile as `authority`: what it looked at joins what the image still served looked at. A
   *  failure whose dependencies were not all observed is reported without a key, so the next boot compiles again. */
  failed(slate: string, authority: string, key: string, failure: SlateBuildFailure): void {
    this.db.exec(
      `INSERT INTO slate_images (slate, authority, failed_key, failure) VALUES (?, ?, ?, ?)
       ON CONFLICT (slate, authority) DO UPDATE SET failed_key = excluded.failed_key, failure = excluded.failure`,
      slate, authority, failure.unobserved === true ? null : key, failure.failed,
    );
    this.looked(slate, authority, failure.inputs ?? []);
    this.#failing.clear();
  }

  private looked(slate: string, authority: string, inputs: readonly SlateBuildRead[]): void {
    for (const { path, missing } of inputs) {
      this.db.exec(
        `INSERT INTO slate_build_inputs (slate, authority, path, missing) VALUES (?, ?, ?, ?)
         ON CONFLICT (slate, authority, path) DO UPDATE SET missing = excluded.missing`,
        slate, authority, path, missing ? 1 : 0,
      );
    }
  }

  /** How many times what `authority`'s builds of `slate` looked at has moved: part of what keys its next build. */
  generation(slate: string, authority: string): number {
    const [row] = this.db.exec(`SELECT generation FROM slate_images WHERE slate = ? AND authority = ?`, slate, authority).toArray();

    return row === undefined ? 0 : v.parse(v.object({ generation: v.number() }), row).generation;
  }

  /**
   * The slates a build of which looked at one of `paths`: a file it read, or a missing path that one of `paths` now is
   * or lies under. Each such build is stale, and whether it builds is not yet known.
   */
  moved(paths: readonly string[], only?: { readonly slate: string; readonly authority: string }): string[] {
    const stale = new Map<string, { readonly slate: string; readonly authority: string }>();

    for (const path of paths) {
      const above = ancestors(path);
      const marks = above.map(() => '?').join(', ');
      const scoped = only === undefined ? '' : ' AND slate = ? AND authority = ?';

      const rows = this.db.exec(
        `SELECT DISTINCT slate, authority FROM slate_build_inputs WHERE (path = ? OR (missing = 1 AND path IN (${marks})))${scoped}`,
        path, ...above, ...(only === undefined ? [] : [only.slate, only.authority]),
      ).toArray();

      for (const row of rows) {
        const pair = v.parse(v.object({ slate: v.string(), authority: v.string() }), row);

        stale.set(JSON.stringify(pair), pair);
      }
    }

    for (const { slate, authority } of stale.values()) {
      this.db.exec(`UPDATE slate_images SET generation = generation + 1, failed_key = NULL, failure = NULL WHERE slate = ? AND authority = ?`, slate, authority);
    }

    if (stale.size > 0) this.#failing.clear();

    return [...new Set([...stale.values()].map((pair) => pair.slate))];
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

  /** Every slate whose latest build as `cred` failed: another caller's refusal says nothing of what this one is served. */
  failing(cred: VfsCred): FailingSlateBuild[] {
    const authority = slateAuthority(cred);
    const known = this.#failing.get(authority);

    if (known !== undefined) return known;

    const failing = this.db.exec(`SELECT slate, failure FROM slate_images WHERE failure IS NOT NULL AND authority = ? ORDER BY slate`, authority).toArray()
      .map((row) => v.parse(v.object({ slate: v.string(), failure: v.string() }), row));

    this.#failing.set(authority, failing);

    return failing;
  }

  /** Its files changed since: whether it builds is not yet known. */
  changed(slates: readonly string[]): void {
    for (const slate of slates) this.db.exec(`UPDATE slate_images SET failed_key = NULL, failure = NULL WHERE slate = ?`, slate);

    if (slates.length > 0) this.#failing.clear();
  }

  forget(slate: string): void {
    this.db.exec(`DELETE FROM slate_images WHERE slate = ?`, slate);
    this.db.exec(`DELETE FROM slate_build_inputs WHERE slate = ?`, slate);
    this.#failing.clear();
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
 * not compiled again. Refused when that authority never built it. Null when something the build looked at changed while
 * it ran: what it compiled is already stale, and is built again.
 */
export function slateImage(input: {
  readonly builds: SlateBuilds;
  readonly slate: string;
  readonly key: string;
  readonly cred: VfsCred;
  readonly build: () => Promise<SlateImage | SlateBuildFailure>;
  /** The paths that changed while the build ran: one it looked at makes what it compiled stale before it is served. */
  readonly changed?: () => readonly string[];
}): Promise<{ readonly image: SlateImage; readonly key: string; readonly broken: string | null } | null> {
  return settle(Effect.gen(function* () {
    const { builds, slate, key } = input;
    const authority = slateAuthority(input.cred);
    const known = builds.failure(slate, authority, key);
    const built = known === null ? yield* Effect.promise(input.build) : { failed: known };

    if (!('failed' in built)) builds.built(slate, authority, key, built);
    else if (known === null) builds.failed(slate, authority, key, built);

    // Its inputs are known only now: a change to one while it compiled moves its generation, as a later one would.
    const changed = known === null ? input.changed?.() ?? [] : [];
    const stale = changed.length > 0 && builds.moved(changed, { slate, authority }).length > 0;

    if (stale) return null;

    if (!('failed' in built)) return { image: built, key, broken: null };
    const good = builds.good(slate, authority);

    if (good === null) return yield* new KinuError('bad_input', built.failed);

    return { image: good.image, key: good.key, broken: built.failed };
  }));
}
