import { Data } from 'effect';
import * as v from 'valibot';
import type { JsonValue } from '../utils/json';
import { renderToolResult } from '../utils/evidence-window';

export const McpProtocolFailureSchema = v.object({ isError: v.literal(true) });

/** A native invocation failed according to MCP; the namespace still exposes its protocol response. */
export class McpToolError extends Data.TaggedError('McpToolError')<{ readonly message: string }> {
  constructor(readonly response: JsonValue) {
    super({ message: 'MCP tool error: ' + renderToolResult(response) });
  }
}
