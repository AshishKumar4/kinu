/**
 * The agent bundle the two-turn probe loads: the shipped facet plus statements over its own SQLite, where main's
 * conversation, sends, claims and runs are kept, and a meter on that SQLite. Exported under the shipped class name,
 * which the workspace object loads by name.
 */
import { CHAT_SESSION_ID, SessionHistory, WorkspaceActorDirectory, type JsonObject, type SqlExecutor, type SqlValue } from '@kinu.run/core';
import { seedTranscriptEntry } from '@kinu.run/test-utils/transcript';
import { AgentFacet as ShippedAgentFacet } from '../../src/agent-facet/agent-facet';
import { meterInPlace, type OperationCost, type SqlMeter } from './sql-meter';
import { Crossings, type PhasedCrossings } from './crossings';

/** The calls the workspace makes into main's isolate while the meter runs, split at each step's grant. */
const crossings = new Crossings('facet.step');

/** Each facet call counted once: the isolate is cached by id, so its class serves every activation. */
let counting = false;

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

  /** `calls` are the facet's calls as the workspace makes them (`AgentFacetCalls`), each counted as it lands. */
  async meterBegin(calls: readonly string[]): Promise<void> {
    if (!counting) crossings.count(ShippedAgentFacet, 'facet', calls);
    counting = true;
    this.meter.begin();
    crossings.begin();
  }

  /** Read once this isolate is idle, so the turn's tail here counts on every run. */
  async meterEnd(): Promise<{ readonly cost: OperationCost; readonly crossings: PhasedCrossings }> {
    await crossings.aside(() => this.idle());

    return { cost: this.meter.end(null), crossings: crossings.end() };
  }

  /** One call this isolate makes into its workspace's relay, and one into each of two RPC targets the relay answers
   *  with: each must show in the workspace's count once, the session's read without the helpers it calls on itself. */
  async plantCrossings(): Promise<void> {
    await this.env.WORKSPACE.logActivity([]);
    const memory = await this.env.WORKSPACE.memory();

    await memory.tail('MEMORY.md', 16);
    const session = await this.env.WORKSPACE.session();

    await session._rpcReadFile('MEMORY.md');
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
