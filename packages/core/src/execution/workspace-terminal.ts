/**
 * The workspace shell's wire, shared by the three things that speak it: the
 * route that forwards the pane's upgrade into the workspace object, the actor
 * that hands the accepted socket to the Nimbus runtime, and the pane.
 *
 * The frames are the runtime's own (`@nimbus-sh/worker` facets/ws-terminal.ts,
 * hosted/runtime.ts `InputFrame`): JSON text each way. The runtime also writes
 * process notices (`spawn`, `exit`, `hmr`) on the same socket; the pane paints
 * output and readiness and drops the rest, so a notice added upstream never
 * breaks a terminal.
 *
 * Client-safe: the pane's bundle holds this module. The
 * runtime's own surface type stays with the host that composes it
 * (cf-backend workspace-host.ts, `WorkspaceTerminal`).
 */

import * as v from 'valibot';
import { DEVICE_PTY_MAX_AXIS } from './device-tunnel';

/**
 * Where the route forwards a workspace terminal upgrade inside the workspace
 * object. A socket cannot cross a Durable Object RPC boundary, but an upgrade
 * request can, and the object's own `fetch` accepts it under this path.
 */
export const WORKSPACE_TERMINAL_PATH = '/_kinu/workspace-terminal';

/** The connection tag a workspace terminal socket carries. Tags ride the
 *  WebSocket attachment, so the lane survives Durable Object hibernation. */
export const WORKSPACE_TERMINAL_TAG = 'terminal:workspace';

/** The window a pane may declare, under the bound the device PTY keeps. */
const axis = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(DEVICE_PTY_MAX_AXIS));

/** What the pane sends: keystrokes, and its window when it changes. */
export const WorkspaceTerminalInputSchema = v.variant('type', [
  v.object({ type: v.literal('input'), data: v.string() }),
  v.object({ type: v.literal('resize'), cols: axis, rows: axis }),
]);

/** What the pane paints: the shell's bytes, and the runtime saying the shell
 *  is attached. */
export const WorkspaceTerminalOutputSchema = v.variant('type', [
  v.object({ type: v.literal('output'), data: v.string() }),
  v.object({ type: v.literal('ready') }),
]);

export function isWorkspaceTerminal(tags: Iterable<string>): boolean {
  for (const tag of tags) if (tag === WORKSPACE_TERMINAL_TAG) return true;

  return false;
}
