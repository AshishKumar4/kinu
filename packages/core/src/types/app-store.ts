/** The app-table mutation vocabulary the run-event ledger records, declared at
 *  the platform layer so the events schema and the codemode store share one
 *  source without the events plane importing the tool. */

/** Whose rows a table holds. */
export const APP_TABLE_SCOPES = ['actor', 'workspace'] as const;

export type AppTableScope = (typeof APP_TABLE_SCOPES)[number];

/**
 * The mutations that leave evidence.
 *
 * Exported so the run-event union does not re-spell them: `db_op` is
 * `RunEventBase & { type: 'db_op' } & DbOpRecord`, the same way `file_edit`
 * carries `FileEditSnapshot` — one declaration, and a member added here cannot
 * fall out of step with the durable schema that records it.
 */
export const APP_MUTATIONS = ['createTable', 'dropTable', 'insert', 'update', 'delete'] as const;

export type AppMutation = (typeof APP_MUTATIONS)[number];

/** One mutation's evidence, as the run-event union carries it. */
export interface DbOpRecord {
  readonly op: AppMutation;
  readonly table: string;
  readonly scope: AppTableScope;
  /** Rows the operation changed. Zero for a schema operation, which changes
   *  the table rather than any row. */
  readonly rowsAffected: number;
  /** How many operations the enclosing all-or-nothing batch held, or null when
   *  this was a single operation. Every row of one batch carries the same
   *  number, so a reader can tell one transaction from several. */
  readonly batch: number | null;
}
