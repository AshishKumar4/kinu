/**
 * One user MCP tool call, made on the user DO that holds the server's connection. An AbortSignal cannot cross the
 * RPC (loaders refuse `enable_abortsignal_rpc`, docs/ARCHITECTURE-DECISIONS.md), so a stop settles the call at once
 * and cancels the server's request on the user DO by the id the call was sent with.
 */
import { Effect } from 'effect';
import type { SerializableToolDescriptor, JsonObject, UserCaller } from '@kinu.run/core';
import { detach, inItsWords, logged, settle } from '@kinu.run/core/obs';
import type { UserDO } from './user/user-do';

export interface UserMcpHub {
  readonly stub: Pick<UserDO, 'userMcp_callTool' | 'userMcp_cancelCall'>;
  readonly caller: UserCaller;
}

/** The user DO's answer as it sent it; `signal` is the calling tool's, and stopping it stops the server's request. */
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
