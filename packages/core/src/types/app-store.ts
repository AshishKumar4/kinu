export const APP_TABLE_SCOPES = ['actor', 'workspace'] as const;

export type AppTableScope = (typeof APP_TABLE_SCOPES)[number];

/** The mutations that leave evidence; the `db_op` run event carries {@link DbOpRecord}. */
export const APP_MUTATIONS = ['createTable', 'dropTable', 'insert', 'update', 'delete'] as const;

export type AppMutation = (typeof APP_MUTATIONS)[number];

export interface DbOpRecord {
  readonly op: AppMutation;
  readonly table: string;
  readonly scope: AppTableScope;
  /** Zero for a schema operation. */
  readonly rowsAffected: number;
  /** Size of the enclosing all-or-nothing batch; null for a single operation. */
  readonly batch: number | null;
}
