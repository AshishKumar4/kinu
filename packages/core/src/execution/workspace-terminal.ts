/**
 * Workspace shell wire (frames are the Nimbus runtime's own JSON). Client-safe: the pane bundles it.
 * The pane drops frames it does not paint, so new upstream notices never break a terminal.
 */

import * as v from 'valibot';
import { DEVICE_PTY_MAX_AXIS } from './device-protocol';

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
  // Nimbus 0.16 marks the shell's prompt and each submitted command's start and end (`ShellIntegrationEvent`).
  v.object({ type: v.literal('shell-integration'), event: v.picklist(['prompt', 'input', 'start', 'finish', 'end']) }),
]);

export function isWorkspaceTerminal(tags: Iterable<string>): boolean {
  for (const tag of tags) if (tag === WORKSPACE_TERMINAL_TAG) return true;

  return false;
}

/** The one shell a workspace had before it kept several: its session's own, under no key. */
export const WORKSPACE_SHELL_SESSION = 'shell';

/** A workspace terminal's key, as a session's id is written (devbox `SessionIdSchema`): the pane's `session`. */
const WorkspaceSessionSchema = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,31}$/u));

/** One terminal the person opened beside the workspace's own, by its key, under the name its tab shows (the devbox's
 *  rule, `SESSION_NAME_MAX`: 1 to 40 characters). */
export const WorkspaceSessionRecordSchema = v.object({
  id: WorkspaceSessionSchema,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40)),
});

export type WorkspaceSessionRecord = v.InferOutput<typeof WorkspaceSessionRecordSchema>;

const SESSION_TAG = 'terminal-session:';

/** The tag a terminal socket keeps its session under, so a frame after hibernation reaches the same shell; none for the
 *  workspace's own shell, or a session that is no session's id. */
export function workspaceSessionTag(session: string | null): readonly string[] {
  return session === null || session === WORKSPACE_SHELL_SESSION || !v.is(WorkspaceSessionSchema, session) ? [] : [`${SESSION_TAG}${session}`];
}

/** The session a terminal socket's tags name; null: the workspace's own shell. */
export function workspaceSessionOf(tags: Iterable<string>): string | null {
  for (const tag of tags) if (tag.startsWith(SESSION_TAG)) return tag.slice(SESSION_TAG.length);

  return null;
}
