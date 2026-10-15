/**
 * A workspace whose storage a release's tables step has not reached, on the real orchestrator over workerd: only the
 * platform shows the object still constructs over such storage, what each entry answers there, and that the step's
 * own call brings it to this build. The probe stamps a claimed workspace as an older build's (identity/schema-stamp.ts)
 * and evicts it, so the next access constructs over that storage, as an account's workspace does after a deploy.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { opsCaller, ownerCaller } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE } from '../../src/rpc-surface';
import { sealRpcSurface } from '@nimbus-sh/fabric/sealed.js';
import type { ChatAnswers, SeedAnswer } from './store-reset-shapes';

export * from '../../src/server';


const PROBE_OWNER_ID = '0123456789abcdef0123456789abcdef';

const PLANTED = 'the older stamp is planted';

/** The production orchestrator with what no production path has: planting the old table, and its wake entry. */
export class OrchestratorAgent extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof ProductionOrchestrator>[1]) {
    super(ctx, env);

    for (const name of ['plantOlderStamp', 'wakeOnce']) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'plantOlderStamp', 'wakeOnce']);
  }

  /** Its storage stamped as an older build's; once that is on disk (an abort discards writes that are not), the
   *  object is evicted, so the next access constructs over it. */
  async plantOlderStamp(): Promise<void> {
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

  /** A claimed workspace, then an older build's stamp planted in its storage and the object evicted over it. */
  async plantRefusedWorkspace(workspace: string): Promise<string> {
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.ensureProfile(owner, 'owner@probe.local', 'Owner');
    await userDO.registerWorkspace(owner, workspace, workspace);
    const claim = await (await this.target(workspace)).claimOwner(PROBE_OWNER_ID);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);

    try {
      await (await this.target(workspace)).plantOlderStamp();

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

  /** The tables step's own call: what it found of the stamp, before it brought the storage to this build. */
  async repaired(workspace: string): Promise<string> {
    return (await (await this.target(workspace)).opsTables(await opsCaller(this.env), { tables: [], drop: true })).stamp;
  }
}
