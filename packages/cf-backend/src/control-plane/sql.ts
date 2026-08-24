/**
 * The SQL protocol the control-plane store is written against.
 *
 * Declared STRUCTURALLY, and that is the whole point of the file: two hosts
 * supply this handle — a Durable Object's `ctx.storage.sql`, and `sqlExec()` over
 * `bun:sqlite` in the test harness — and both satisfy the shape below without an
 * assertion at either call site. The earlier version narrowed the platform type
 * with `as unknown as`, which discarded evidence to work around nothing more than
 * two identical value unions declared in two places.
 *
 * `toArray()` answers rows as a concrete dictionary rather than as `unknown`,
 * because a SQLite row IS a map of column name to scalar. What it is not is a
 * KNOWN column set: that is a runtime fact about durable storage written by an
 * earlier version of the code, which is why `store.ts` parses every read with a
 * schema instead of asserting one.
 */

/**
 * Everything SQLite can hand back or take as a binding.
 *
 * The UNION of what the two hosts declare, deliberately: the platform's
 * `SqlStorageValue` is `ArrayBuffer | string | number | null`, and core's
 * `SqlValue` adds `boolean`. Taking the union is what makes both hosts assignable
 * here with no assertion — a row map with narrower values satisfies one with
 * wider values, and a binding parameter that accepts more satisfies one that
 * promises less. Taking the intersection instead is what forced the cast this
 * file used to carry.
 */
export type ControlPlaneSqlValue = ArrayBuffer | string | number | boolean | null;

/** One row, before a schema says what its columns mean. */
export type ControlPlaneSqlRow = Record<string, ControlPlaneSqlValue>;

export interface ControlPlaneSql {
  exec(query: string, ...bindings: ControlPlaneSqlValue[]): {
    toArray(): ControlPlaneSqlRow[];
  };
}
