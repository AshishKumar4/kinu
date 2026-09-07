import * as v from 'valibot';
import type { JsonValue } from '../utils/json';
import { renderToolResult } from '../prompts/evidence-window';

export const McpProtocolFailureSchema = v.object({ isError: v.literal(true) });

/** A native invocation failed according to MCP; the namespace still exposes its protocol response. */
export class McpToolError extends Error {
  override readonly name = 'McpToolError';

  constructor(readonly response: JsonValue) {
    super('MCP tool error: ' + renderToolResult(response));
  }
}
