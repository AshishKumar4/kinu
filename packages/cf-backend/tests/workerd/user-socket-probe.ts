/**
 * Since cloudflare/agents#2133 `Agent` declares no `webSocketMessage`, but the base type still
 * does: only the real chain on workerd catches a `super` call from the override.
 */
import type { AgentContext } from 'agents';
import { USER_DO_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import { UserDO } from '../../src/user/user-do';

export type SocketOutcome = 'handled' | { readonly threw: string };

export class UserSocketProbeDO extends UserDO {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof UserDO>[1]) {
    super(ctx, env);
    Reflect.deleteProperty(this, 'deliverBareFrame');
    sealRpcSurface(this, [...USER_DO_RPC_SURFACE, 'deliverBareFrame']);
  }

  async deliverBareFrame(): Promise<SocketOutcome> {
    // No attachment, so the frame lands on the lifecycle branch alone.
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
