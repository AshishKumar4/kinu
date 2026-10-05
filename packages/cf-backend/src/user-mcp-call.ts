/** An AbortSignal cannot cross the RPC (docs/ARCHITECTURE-DECISIONS.md), so a stop cancels the call on the user DO by its id. */
import { Effect } from 'effect';
import type { SerializableToolDescriptor, JsonObject, UserCaller } from '@kinu.run/core';
import { detach, inItsWords, logged, settle } from '@kinu.run/core/obs';
import type { UserDO } from './user/user-do';

export interface UserMcpHub {
  readonly stub: Pick<UserDO, 'userMcp_callTool' | 'userMcp_cancelCall'>;
  readonly caller: UserCaller;
}

/** Stopping `signal` stops the server's request. */
export function callUserMcpTool(
  hub: UserMcpHub,
  tool: Pick<SerializableToolDescriptor, 'serverId' | 'name'>,
  args: JsonObject,
  signal: AbortSignal | undefined,
): Promise<string> {
  const callId = crypto.randomUUID();

  // Through the stub the call went out on, so the call reaches the user DO first.
  const cancel = (): void => {
    detach(logged('mcp.call_cancel_failed', { doing: `cancelling ${tool.name} on its MCP server`, otherwise: 'unavailable' },
      () => hub.stub.userMcp_cancelCall(hub.caller, callId)));
  };

  const called = inItsWords('unavailable', Effect.promise((stopped) => {
    stopped.addEventListener('abort', cancel, { once: true });

    return hub.stub.userMcp_callTool(hub.caller, { serverId: tool.serverId, name: tool.name, args, id: callId });
  }));

  return settle(called, { signal, interrupted: `${tool.name} was stopped before its MCP server answered` });
}
