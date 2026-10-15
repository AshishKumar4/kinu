/** MCP tool key for both backends: `<server>/<tool>`, keyed on the user-chosen server name (unique per agent), never the registration id. */
import { fnv1a32Hex } from '../utils/fnv1a';

/** Characters outside `[A-Za-z0-9_-]` (accepted by every target provider) become `_`. */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, '_');
}

const TOOL_NAME_MAX = 64;

export function mcpToolKey(serverName: string, toolName: string): string {
  const key = `mcp_${sanitizeSegment(serverName)}_${sanitizeSegment(toolName)}`;

  return key.length <= TOOL_NAME_MAX ? key : suffixedMcpToolKey(serverName, toolName);
}

export function suffixedMcpToolKey(serverName: string, toolName: string): string {
  const key = `mcp_${sanitizeSegment(serverName)}_${sanitizeSegment(toolName)}`;
  const suffix = fnv1a32Hex(`${serverName}\u0000${toolName}`);

  return `${key.slice(0, TOOL_NAME_MAX - suffix.length - 1)}_${suffix}`;
}

/** True for keys minted by `mcpToolKey`. */
export function isMcpToolKey(key: string): boolean {
  return key.startsWith('mcp_');
}
