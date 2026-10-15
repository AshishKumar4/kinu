/**
 * A workspace whose storage a release's tables step has not reached, on the real orchestrator over workerd: only the
 * platform shows the object still constructs over such storage, what each entry answers there, and that the step's
 * own call brings it to this build. The probe stamps a claimed workspace as an older build's (identity/schema-stamp.ts)
 * and evicts it, so the next access constructs over that storage, as an account's workspace does after a deploy.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { opsCaller, ownerCaller, repairSchema, type Repair, type TablesAnswer } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE } from '../../src/rpc-surface';
import { sealRpcSurface } from '@nimbus-sh/fabric/sealed.js';
import type { ChatAnswers, SeedAnswer } from './store-reset-shapes';

export * from '../../src/server';


const PROBE_OWNER_ID = '0123456789abcdef0123456789abcdef';

const PLANTED = 'the older stamp is planted';

/** How a planted workspace was left: a column the build before had (rebuilt away, its rows kept), or a table whose
 *  rows this build's shape cannot take (refused). */
export type Planted = 'stale' | 'refusing';

/** The production orchestrator with what no production path has: planting an older build's storage, and its wake
 *  entry. */
export class OrchestratorAgent extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof ProductionOrchestrator>[1]) {
    super(ctx, env);

    for (const name of ['plantOlderStamp', 'wakeOnce']) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'plantOlderStamp', 'wakeOnce']);
  }

  /** Its storage left as an older build's, with an older stamp; once that is on disk (an abort discards writes that
   *  are not), the object is evicted, so the next access constructs over it. */
  async plantOlderStamp(planted: Planted): Promise<void> {
    const { sql } = this.ctx.storage;

    if (planted === 'stale') {
      sql.exec('ALTER TABLE trial_turns ADD COLUMN arm TEXT');
      sql.exec("INSERT INTO trial_turns (actor_id, trial_id, turn_id, segment_id, at, arm) VALUES ('main', 'trial', 'turn', 'segment', 1, 'candidate')");
    } else {
      sql.exec('DROP TABLE trial_turns');
      sql.exec('CREATE TABLE trial_turns (actor_id TEXT NOT NULL, trial_id TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY (actor_id, trial_id, turn_id))');
      sql.exec("INSERT INTO trial_turns VALUES ('main', 'trial', 'turn')");
    }

    this.ctx.storage.kv.put('kinu.schema_stamp', 1);
    await this.ctx.storage.sync();
    this.ctx.abort(PLANTED);
  }

  /** The platform's wake entry: answers once it returned, so a refusal it threw reaches the caller instead. */
  async wakeOnce(): Promise<string> {
    await this.alarm();

    return 'returned';
  }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

/** `durableObjects` installs this module's `OrchestratorAgent` under that name, so every stub carries its methods. */
interface ProbeRootEnv extends Omit<ProbeEnv, 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
}

/** A `Pick` intersection: the full stub type instantiates too deeply to compile. */
type ResetTarget = Pick<Fetcher, 'fetch'>
  & Pick<ProductionOrchestrator, 'claimOwner' | 'exportWorkspaceArchive' | 'opsTables'>
  & Pick<OrchestratorAgent, 'plantOlderStamp' | 'wakeOnce'>;

const FrameSchema = v.looseObject({ type: v.string(), done: v.optional(v.boolean()), error: v.optional(v.boolean()) });

/** The next frame that ends a chat response in failure, as the page's `terminalChatError` reads it, as JSON text. */
function nextTerminalFrame(socket: WebSocket): Promise<string> {
  const arrived = Promise.withResolvers<string>();

  const listen = (event: MessageEvent): void => {
    if (!v.is(v.string(), event.data)) return;
    const frame = v.safeParse(FrameSchema, JSON.parse(event.data));

    if (!frame.success || frame.output.type !== 'cf_agent_use_chat_response' || frame.output.done !== true) return;

    if (frame.output.error !== true) return;
    socket.removeEventListener('message', listen);
    arrived.resolve(event.data);
  };

  socket.addEventListener('message', listen);

  return arrived.promise;
}

export class StoreResetProbeRoot extends DurableObject<ProbeRootEnv> {
  private target(workspace: string): Promise<ResetTarget> {
    return getAgentByName<ProbeEnv, OrchestratorAgent>(this.env.OrchestratorAgent, workspace);
  }

  /** A claimed workspace, then an older build's storage planted and the object evicted over it. */
  async plantOlderWorkspace(workspace: string, planted: Planted): Promise<string> {
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.ensureProfile(owner, 'owner@probe.local', 'Owner');
    await userDO.registerWorkspace(owner, workspace, workspace);
    const claim = await (await this.target(workspace)).claimOwner(PROBE_OWNER_ID);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);

    try {
      await (await this.target(workspace)).plantOlderStamp(planted);

      return 'the object answered after its eviction';
    } catch (cause) {
      return renderThrownChain({ cause });
    }
  }

  async seed(workspace: string): Promise<SeedAnswer> {
    const response = await (await this.target(workspace))
      .fetch(new Request(`https://probe/agents/orchestrator-agent/${workspace}/get-messages`));

    return { status: response.status, body: await response.text() };
  }

  /** The owner's tab: the frame it gets on connect, then the answer to a message it sends. */
  async chat(workspace: string): Promise<ChatAnswers> {
    const upgraded = await (await this.target(workspace)).fetch(new Request(`https://probe/agents/orchestrator-agent/${workspace}`, {
      headers: { Upgrade: 'websocket' },
    }));

    const socket = upgraded.webSocket;

    if (upgraded.status !== 101 || socket === null) throw new Error(`the socket answered ${String(upgraded.status)}`);

    const connectedFrame = nextTerminalFrame(socket);

    socket.accept();
    const connected = await connectedFrame;
    const answeredFrame = nextTerminalFrame(socket);

    socket.send(JSON.stringify({
      type: 'cf_agent_use_chat_request', id: 'refused-send',
      init: { method: 'POST', body: JSON.stringify({
        messages: [{ id: 'input-refused-send', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
        trigger: 'submit-message',
      }) },
    }));
    const answered = await answeredFrame;
    socket.close(1000, 'store reset probe complete');

    return { connected, answered };
  }

  async wake(workspace: string): Promise<string> {
    try {
      return await (await this.target(workspace)).wakeOnce();
    } catch (cause) {
      return renderThrownChain({ cause });
    }
  }

  /** Its export, or why it was refused. */
  async exported(workspace: string): Promise<string> {
    try {
      return `${String((await (await this.target(workspace)).exportWorkspaceArchive()).lines.length)} line(s)`;
    } catch (cause) {
      return renderThrownChain({ cause });
    }
  }

  /**
   * A reshaped table rebuilt on this object's own SQLite, as a repair rebuilds one on a Durable Object: what the
   * platform admits of it (renames, the deferred foreign keys, `table_info`, `foreign_key_check`, a rowid copied back)
   * is only seen here. Its rows, a referring table's, and the rowids must all survive.
   */
  async rebuilt(): Promise<{ readonly repair: Pick<Repair, 'rebuilt' | 'refused'> | null; readonly notes: unknown[]; readonly children: unknown[] }> {
    const { sql } = this.ctx.storage;
    let stamp = 1;

    sql.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT, CHECK (digest IS NULL OR length(digest) = 4))`);
    sql.exec(`CREATE INDEX notes_digest ON notes(digest)`);
    sql.exec(`CREATE TABLE notes_children (id TEXT PRIMARY KEY, note TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE)`);
    sql.exec(`INSERT INTO notes (rowid, id, body, digest) VALUES (7, 'a', 'kept', 'abcd')`);
    sql.exec(`INSERT INTO notes_children VALUES ('c', 'a')`);

    const repair = repairSchema(sql, {
      schema: 'agent', tables: ['notes', 'notes_children'], stamps: { read: () => stamp, write: (next) => { stamp = next; } },
      transactionSync: this.ctx.storage.transactionSync.bind(this.ctx.storage),
      init: () => {
        sql.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
        sql.exec(`CREATE TABLE IF NOT EXISTS notes_children (id TEXT PRIMARY KEY, note TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE)`);
      },
    }, 'probe');

    return {
      repair: repair === null ? null : { rebuilt: repair.rebuilt, refused: repair.refused },
      notes: sql.exec('SELECT rowid AS r, id, body FROM notes').toArray(),
      children: sql.exec('SELECT id, note FROM notes_children').toArray(),
    };
  }

  /** The deploy's walk of `workspace`: what its repair did, why it is refused if it is, and the agents it opened. */
  async walked(workspace: string): Promise<Pick<TablesAnswer, 'refused' | 'agents'> & { readonly rebuilt: readonly string[] }> {
    const answer = await (await this.target(workspace)).opsTables(await opsCaller(this.env));

    return { rebuilt: answer.repair?.rebuilt ?? [], refused: answer.refused, agents: answer.agents };
  }
}
