/** What each domain of the user object (user-do.ts) reads from it. */
import type { AgentContext } from 'agents';
import * as v from 'valibot';
import type { ResolvedCaller, UserCaller, WorkspaceCapability } from '@kinu.run/core';

export interface SqlRow extends Record<string, SqlStorageValue> {}

export interface UserObjectHost {
  readonly ctx: AgentContext;
  readonly env: Env;
  sqlx<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlStorageValue[]): T[];
  requireTier(caller: UserCaller, capability: WorkspaceCapability): Promise<ResolvedCaller>;
}

/** What a single-row table's one row holds in the column `query` selects as `value`; undefined before it is written. */
export function singletonValue<T extends v.GenericSchema<SqlStorageValue>>(sqlx: UserObjectHost['sqlx'], query: string, schema: T): v.InferOutput<T> | undefined {
  const row = sqlx(query)[0];

  return row === undefined ? undefined : v.parse(schema, row.value);
}
