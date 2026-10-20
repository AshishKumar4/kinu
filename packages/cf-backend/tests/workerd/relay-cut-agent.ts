/**
 * The agent bundle the hire probe loads: the shipped facet, whose live relay a workspace named `relay-cut-…` loses at the
 * line telling of a shell call, as chat-builder's did when a storage reset cut its running step (1008-aa, 2026-10-08).
 * The room reads its end of the stream it received over RPC as the platform tells it, in chat-builder's words
 * ("ReadableStream received over RPC disconnected prematurely."; the agent's isolate logs the ended stream as an uncaught
 * rejection), and the step's stream call is refused as a lost session refuses it. Every other workspace's agent is the
 * shipped facet unchanged.
 */
import { AgentFacet as ShippedAgentFacet, type AgentFacetEnv } from '../../src/agent-facet/agent-facet';
import { disposeRpc, type AgentWorkspaceCalls, type AgentWorkspacePort } from '../../src/agent-facet/workspace-rpc';

const RELAY_CUT_WORKSPACE = 'relay-cut-';

/** The platform's words for the stream chat-builder's room lost, as the step's lost session refused its call. */
const SEVERED = 'ReadableStream received over RPC disconnected prematurely.';

/** `lines`, ended in error once one tells of a shell call: its reader in the room meets what the platform tells of that. */
function cutAtShellCall(lines: ReadableStream<Uint8Array>) {
  const reader = lines.getReader();
  const decoder = new TextDecoder();
  let cut = false;

  const stream = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const next = await reader.read();

      if (next.done) {
        controller.close();

        return;
      }

      controller.enqueue(next.value);
      const text = decoder.decode(next.value);

      if (!text.includes('"type":"tool-input-available"') || !text.includes('"toolName":"shell"')) return;
      cut = true;
      controller.error(new Error('the relay-cut probe ended this relay at a shell call'));
      await reader.cancel();
    },
    cancel: async (reason) => { await reader.cancel(reason); },
  });

  return { stream, cut: () => cut };
}

function severing(port: AgentWorkspacePort): AgentWorkspacePort {
  const observe: AgentWorkspacePort['observe'] = async (lines) => {
    const severed = cutAtShellCall(lines);
    const sent = port.observe(severed.stream);

    try {
      await sent;
    } finally {
      disposeRpc(sent);
    }

    if (severed.cut()) throw new Error(SEVERED);
  };

  return new Proxy(port, { get: (target, key: keyof AgentWorkspacePort) => (key === 'observe' ? observe : target[key]) });
}

/** Its port's opening keeps the disposer the agent lets it go with. */
function severedRelays(workspace: AgentWorkspaceCalls): AgentWorkspaceCalls {
  return {
    session: () => workspace.session(),
    stateSession: () => workspace.stateSession(),
    memory: () => workspace.memory(),
    program: (...args) => workspace.program(...args),
    port: () => {
      const opened = workspace.port();

      return Object.assign(opened.then(severing), { [Symbol.dispose]: () => { disposeRpc(opened); } });
    },
  };
}

export class AgentFacet extends ShippedAgentFacet {
  constructor(ctx: DurableObjectState, env: AgentFacetEnv) {
    super(ctx, env.WORKSPACE_NAME.startsWith(RELAY_CUT_WORKSPACE) ? { ...env, WORKSPACE: severedRelays(env.WORKSPACE) } : env);
  }
}
