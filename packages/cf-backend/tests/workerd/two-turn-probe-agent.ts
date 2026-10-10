/**
 * The agent bundle the two-turn probe loads: the shipped facet plus statements over its own SQLite, where main's
 * conversation, sends, claims and runs are kept, and a meter on that SQLite. Exported under the shipped class name,
 * which the workspace object loads by name.
 */
import { CHAT_SESSION_ID, SessionHistory, WorkspaceActorDirectory, type JsonObject, type SqlExecutor, type SqlValue } from '@kinu.run/core';
import { seedTranscriptEntry } from '@kinu.run/test-utils/transcript';
import { AgentFacet as ShippedAgentFacet } from '../../src/agent-facet/agent-facet';
import { meterInPlace, type OperationCost, type SqlMeter } from './sql-meter';

/** An entry of main's conversation as a dead activation left it. */
export interface SeededEntry {
  readonly id: string;
  readonly origin: 'input' | 'output';
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly metadata?: JsonObject;
}

export class AgentFacet extends ShippedAgentFacet {
  /** Main's statements, counted while the two-turn probe measures a turn. */
  private readonly meter: SqlMeter;
  /** The database without the meter, for the probe's own reads. */
  private readonly unmetered: SqlStorage['exec'];

  constructor(...args: ConstructorParameters<typeof ShippedAgentFacet>) {
    super(...args);
    const metered = meterInPlace(this.ctx.storage.sql);

    this.meter = metered.meter;
    this.unmetered = metered.unmetered;
  }

  async meterBegin(): Promise<void> {
    this.meter.begin();
  }

  /** Read once this isolate is idle, so the turn's tail here counts on every run. */
  async meterEnd(): Promise<OperationCost> {
    await this.idle();

    return this.meter.end(null);
  }

  /** `query` over this agent's own SQLite: its rows for a read, none for a statement. */
  async probeRows(query: string, ...bindings: SqlStorageValue[]): Promise<Array<Record<string, SqlStorageValue>>> {
    return this.unmetered(query, ...bindings).toArray();
  }

  /** `entries` into `actorId`'s conversation, as its store records them; their text is short enough to need no files. */
  async seedChat(actorId: string, entries: readonly SeededEntry[]): Promise<void> {
    const sql: SqlExecutor = <T,>(query: TemplateStringsArray, ...values: SqlValue[]): T[] =>
      this.ctx.storage.sql.exec<Extract<T, Record<string, SqlStorageValue>>>(query.join('?'), ...values).toArray();

    const [identity] = sql<{ id: string; owner_user_id: string | null }>`SELECT id, owner_user_id FROM workspace_identity`;

    if (identity === undefined) throw new Error('the agent database holds no workspace identity yet');
    const actor = new WorkspaceActorDirectory(sql, { workspaceId: identity.id, ownerUserId: identity.owner_user_id }).open(actorId);

    const history = new SessionHistory({
      sql, actor, transactionSync: (write) => this.ctx.storage.transactionSync(write),
      files: async () => { throw new Error('a seeded entry is short enough to need no files'); },
    });

    for (const entry of entries) {
      await seedTranscriptEntry(history, CHAT_SESSION_ID, {
        id: entry.id, origin: entry.origin, message: { role: entry.role, content: entry.content },
        ...(entry.metadata !== undefined && { metadata: entry.metadata }),
      });
    }
  }
}
