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
import { claimFences } from '@kinu.run/core';
import { SCREENS, screenData, screenEntry } from './two-turn-shapes';

/** The calls the workspace makes into main's isolate while the meter runs: one phase, since a turn's steps run under the
 *  one grant it holds while its budget lasts (`step-pacer.ts`), and nothing else is called into it per step. */
const crossings = new Crossings(null);

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

  /** One call this isolate makes through its port, and one into each of two RPC targets the relay answers with: each
   *  must show in the workspace's count once, the session's read without the helpers it calls on itself. */
  async plantCrossings(): Promise<void> {
    await (await this.env.WORKSPACE.port()).logActivity([]);
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
    const history = this.historyOf(actorId);

    for (const entry of entries) {
      await seedTranscriptEntry(history, CHAT_SESSION_ID, {
        id: entry.id, origin: entry.origin, message: { role: entry.role, content: entry.content },
        ...(entry.metadata !== undefined && { metadata: entry.metadata }),
      });
    }
  }

  /** An ask, then {@link SCREENS} answers that each took a screenshot of the computer, as a computer-use turn keeps them:
   *  a tool result handed to the model with its image. Each answer is short enough to stay in its row; all together are
   *  past what one crossing carries. */
  async seedScreens(actorId: string): Promise<void> {
    const history = this.historyOf(actorId);

    await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: 'screens-ask', origin: 'input', message: { role: 'user', content: 'Play the level through.' } });

    for (let index = 0; index < SCREENS; index += 1) {
      const call = `screen-${String(index)}`;

      await seedTranscriptEntry(history, CHAT_SESSION_ID, {
        id: screenEntry(index), origin: 'output',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call' as const, toolCallId: call, toolName: 'computer', input: { op: 'screen' } },
            {
              type: 'tool-result' as const, toolCallId: call, toolName: 'computer',
              output: { type: 'content' as const, value: [{ type: 'text' as const, text: `screen ${String(index)}` }, { type: 'file' as const, data: { type: 'data' as const, data: screenData(index) }, mediaType: 'image/png' }] },
            },
          ],
        },
      });
    }
  }

  private historyOf(actorId: string): SessionHistory {
    const sql: SqlExecutor = <T,>(query: TemplateStringsArray, ...values: SqlValue[]): T[] =>
      this.ctx.storage.sql.exec<Extract<T, Record<string, SqlStorageValue>>>(query.join('?'), ...values).toArray();

    const [identity] = sql<{ id: string; owner_user_id: string | null }>`SELECT id, owner_user_id FROM workspace_identity`;

    if (identity === undefined) throw new Error('the agent database holds no workspace identity yet');
    const actor = new WorkspaceActorDirectory(sql, { workspaceId: identity.id, ownerUserId: identity.owner_user_id }).open(actorId);

    return new SessionHistory({
      sql, actor, transactionSync: (write) => this.ctx.storage.transactionSync(write),
      files: async () => { throw new Error('a seeded entry is short enough to need no files'); },
      claims: claimFences(sql, actor),
    });
  }
}
