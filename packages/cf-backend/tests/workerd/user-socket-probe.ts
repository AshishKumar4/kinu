/**
 * A frame on a UserDO socket that is neither a device daemon's nor a terminal
 * pane's, delivered to the real class on real workerd. Since
 * cloudflare/agents#2133 `Agent` declares no `webSocketMessage`, so the class's
 * override cannot reach a `super` implementation and hands the frame to
 * `this.lifecycle` itself. Under agents 0.20 the old `super` call resolved;
 * under 0.22 it was `undefined()` for every such socket, and the unit suite
 * cannot see it: the base TYPE still declares the method, so the call
 * typechecks against a prototype that no longer carries it. Only the real
 * chain reaches the throw, which is why this runs in-object over workerd.
 */
import type { AgentContext } from 'agents';
import { USER_DO_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import { UserDO } from '../../src/user/user-do';

export type SocketOutcome = 'handled' | { readonly threw: string };

export class UserSocketProbeDO extends UserDO {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof UserDO>[1]) {
    super(ctx, env);
    // The production seal, plus this one probe method: the same shape the
    // plan-announce probe uses, so the test reaches the real class through the
    // real boundary rather than around it.
    Reflect.deleteProperty(this, 'deliverBareFrame');
    sealRpcSurface(this, [...USER_DO_RPC_SURFACE, 'deliverBareFrame']);
  }

  async deliverBareFrame(): Promise<SocketOutcome> {
    // No attachment: `terminalFromSocket` and `deviceIdFromSocket` both answer
    // nothing, so the frame lands on the lifecycle branch alone.
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    client.accept();

    try {
      await this.webSocketMessage(server, JSON.stringify({ type: 'cf_agent_state', state: { probe: true } }));

      return 'handled';
    } catch (cause) {
      return { threw: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}
