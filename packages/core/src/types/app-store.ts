export const APP_TABLE_SCOPES = ['actor', 'workspace', 'private'] as const;

export type AppTableScope = (typeof APP_TABLE_SCOPES)[number];

/**
 * What a table's scope means, the one answer every reader of a scope asks: whether each row belongs to the agent that
 * wrote it, whether a workspace fork copies the table, and whether a slate's call (or a crafted tool a slate runs)
 * reaches it. A `private` table is the agent's own scratch, which no fork and no slate sees.
 */
export const APP_TABLE_SCOPE = {
  actor: { agentBound: true, forks: true, slates: true },
  workspace: { agentBound: false, forks: true, slates: true },
  private: { agentBound: true, forks: false, slates: false },
} as const satisfies Readonly<Record<AppTableScope, { readonly agentBound: boolean; readonly forks: boolean; readonly slates: boolean }>>;

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
