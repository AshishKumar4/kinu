/**
 * The agent bundle the two-turn probe loads: the shipped facet plus statements over its own SQLite, where main's
 * conversation, sends, claims and runs are kept. Exported under the shipped class name, which the workspace object
 * loads by name.
 */
import { CHAT_SESSION_ID, SessionHistory, WorkspaceActorDirectory, type JsonObject, type SqlExecutor, type SqlValue } from '@kinu.run/core';
import { seedTranscriptEntry } from '@kinu.run/test-utils/transcript';
import { AgentFacet as ShippedAgentFacet } from '../../src/agent-facet/agent-facet';

/** An entry of main's conversation as a dead activation left it. */
export interface SeededEntry {
  readonly id: string;
  readonly origin: 'input' | 'output';
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly metadata?: JsonObject;
}

export class AgentFacet extends ShippedAgentFacet {
  /** `query` over this agent's own SQLite: its rows for a read, none for a statement. */
  async probeRows(query: string, ...bindings: SqlStorageValue[]): Promise<Array<Record<string, SqlStorageValue>>> {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray();
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
