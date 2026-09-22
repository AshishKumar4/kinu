/**
 * Workspace shell wire (frames are the Nimbus runtime's own JSON). Client-safe: the pane bundles it.
 * The pane drops frames it does not paint, so new upstream notices never break a terminal.
 */

import * as v from 'valibot';
import { DEVICE_PTY_MAX_AXIS } from './device-tunnel';

/** A socket cannot cross a Durable Object RPC boundary; the upgrade request is forwarded here instead. */
export const WORKSPACE_TERMINAL_PATH = '/_kinu/workspace-terminal';

/** Tags ride the WebSocket attachment, so the lane survives Durable Object hibernation. */
export const WORKSPACE_TERMINAL_TAG = 'terminal:workspace';

const axis = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(DEVICE_PTY_MAX_AXIS));

export const WorkspaceTerminalInputSchema = v.variant('type', [
  v.object({ type: v.literal('input'), data: v.string() }),
  v.object({ type: v.literal('resize'), cols: axis, rows: axis }),
]);

export const WorkspaceTerminalOutputSchema = v.variant('type', [
  v.object({ type: v.literal('output'), data: v.string() }),
  v.object({ type: v.literal('ready') }),
]);

export function isWorkspaceTerminal(tags: Iterable<string>): boolean {
  for (const tag of tags) if (tag === WORKSPACE_TERMINAL_TAG) return true;

  return false;
}
