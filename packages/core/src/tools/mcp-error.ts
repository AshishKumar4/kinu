import { Data, Effect } from 'effect';
import * as v from 'valibot';
import type { JsonValue } from '../utils/json';
import { settleSync } from '../obs/index';
import { renderToolResult } from '../utils/evidence-window';

export const McpProtocolFailureSchema = v.object({ isError: v.literal(true) });

/** A native invocation failed according to MCP; the namespace still exposes its protocol response. */
export class McpToolError extends Data.TaggedError('McpToolError')<{ readonly message: string }> {
  constructor(readonly response: JsonValue) {
    super({ message: 'MCP tool error: ' + renderToolResult(response) });
  }
}

/** An MCP call's response as every backend hands it to the program that made it: the server's whole response, or the
 *  call's failure where MCP says it failed. A transport (stdio on the CLI, the account's RPC on the cloud) only fetches
 *  and decodes it. */
export function mcpCallResult(response: JsonValue): JsonValue {
  return settleSync(v.is(McpProtocolFailureSchema, response) ? Effect.die(new McpToolError(response)) : Effect.succeed(response));
}
