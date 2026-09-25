/**
 * A workspace whose store predates the conversation store's storage reset, on the real orchestrator over workerd:
 * only the platform shows the object still constructs over such a store, and what each entry answers there. The
 * probe plants the 2026-09-21 `session_messages` in a claimed workspace and evicts it, so the next access
 * constructs over the planted store, as the account's workspace does after a deploy.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { ownerCaller } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import type { ChatAnswers, SeedAnswer } from './store-reset-shapes';

export { UserDO } from '../../src/user/user-do';

/** `session_messages` as a 2026-09-21 build created it (5682c7907), before its envelope and sealed content columns. */
const PRE_RESET_SESSION_MESSAGES = `CREATE TABLE IF NOT EXISTS session_messages (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), message_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
    native_content_kind TEXT NOT NULL CHECK(native_content_kind IN ('string','parts')),
    origin TEXT NOT NULL CHECK(origin IN ('input','output','edit','context_transform','render')),
    request_id TEXT, output_slot INTEGER, ingress_id TEXT, sealed_sequence INTEGER,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,message_id), UNIQUE(actor_id,request_id,output_slot),
    FOREIGN KEY(actor_id,request_id) REFERENCES actor_requests(actor_id,request_id),
    FOREIGN KEY(actor_id,message_id,sealed_sequence) REFERENCES message_updates(actor_id,message_id,sequence),
    CHECK(output_slot IS NULL OR output_slot >= 0),
    CHECK((request_id IS NULL) = (output_slot IS NULL)))`;

const PROBE_OWNER_ID = '0123456789abcdef0123456789abcdef';

const PLANTED = 'the pre-reset store is planted';

/** The production orchestrator with what no production path has: planting the old table, and its wake entry. */
export class OrchestratorAgent extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof ProductionOrchestrator>[1]) {
    super(ctx, env);

    for (const name of ['plantPreResetSessionMessages', 'wakeOnce']) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'plantPreResetSessionMessages', 'wakeOnce']);
  }

  /** The current table is set aside under another name, so no foreign key has to be undone. Its indexes go with it
   *  and their names would satisfy the next `CREATE INDEX IF NOT EXISTS`, so they are dropped: the account's store
   *  never had them. Once that is on disk (an abort discards writes that are not), the object is evicted, so the
   *  next access constructs over it. */
  async plantPreResetSessionMessages(): Promise<void> {
    const sql = this.ctx.storage.sql;

    sql.exec('ALTER TABLE session_messages RENAME TO session_messages_current');

    const moved = sql.exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_messages_current'
      AND sql IS NOT NULL`).toArray().map((row) => v.parse(NamedSchema, row).name);

    for (const name of moved) sql.exec(`DROP INDEX "${name}"`);
    sql.exec(PRE_RESET_SESSION_MESSAGES);
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
  & Pick<ProductionOrchestrator, 'claimOwner' | 'exportWorkspaceArchive'>
  & Pick<OrchestratorAgent, 'plantPreResetSessionMessages' | 'wakeOnce'>;

const NamedSchema = v.object({ name: v.string() });

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

  /** A claimed workspace, then the old table planted in its store and the object evicted over it. */
  async plantRefusedWorkspace(workspace: string): Promise<string> {
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.ensureProfile(owner, 'owner@probe.local', 'Owner');
    await userDO.registerWorkspace(owner, workspace, workspace);
    const claim = await (await this.target(workspace)).claimOwner(PROBE_OWNER_ID);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);

    try {
      await (await this.target(workspace)).plantPreResetSessionMessages();

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

  async exportedLines(workspace: string): Promise<number> {
    return (await (await this.target(workspace)).exportWorkspaceArchive()).lines.length;
  }
}
