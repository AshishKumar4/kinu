/**
 * Structural SQL protocol, satisfied by both a DO's `ctx.storage.sql` and
 * `sqlExec()` over `bun:sqlite` without assertions.
 */

/** The union of both hosts' value types, so either is assignable without a cast. */
export type ControlPlaneSqlValue = ArrayBuffer | string | number | boolean | null;

export type ControlPlaneSqlRow = Record<string, ControlPlaneSqlValue>;

export interface ControlPlaneSql {
  exec(query: string, ...bindings: ControlPlaneSqlValue[]): {
    toArray(): ControlPlaneSqlRow[];
  };
}
