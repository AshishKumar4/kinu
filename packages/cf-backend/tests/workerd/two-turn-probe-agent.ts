/**
 * The agent bundle the two-turn probe loads: the shipped facet plus statements over its own SQLite, where main's
 * conversation, sends, claims and runs are kept. Exported under the shipped class name, which the workspace object
 * loads by name.
 */
import { AgentFacet as ShippedAgentFacet } from '../../src/agent-facet/agent-facet';

export class AgentFacet extends ShippedAgentFacet {
  /** `query` over this agent's own SQLite: its rows for a read, none for a statement. */
  async probeRows(query: string, ...bindings: SqlStorageValue[]): Promise<Array<Record<string, SqlStorageValue>>> {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray();
  }
}
