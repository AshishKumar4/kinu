/**
 * Workspace fork — the driver.
 *
 * What has to happen before {@link snapshotWorkspaceForFork} runs, and after
 * it: refuse to cut a workspace mid-turn, resolve and validate the fork's name,
 * refuse to overwrite a name someone already asked for, ship the snapshot, and
 * report where it landed. None of that is Durable-Object-shaped — it was
 * written as a DO method, which is why a fork existed on exactly one backend
 * and why the payload's query set had a second, hand-maintained transcription
 * (a SqlExecutor shim answering the exact SELECTs the copy issues) living
 * beside it. Core owns both ends of the query set now, so the shim is gone.
 *
 * What a backend supplies is a {@link ForkTransport}: how to reach a workspace
 * that does not exist yet. On Cloudflare that is a Durable Object addressed by
 * name and an RPC that carries the snapshot; elsewhere it is a new database.
 * That is the whole of the per-backend difference.
 */

import type { VFS, SqlExecutor } from '../types/primitives';
import { nanoid } from '../utils/nanoid';
import { snapshotWorkspaceForFork, type ForkSnapshot } from './fork';

/**
 * A fork's name. Stricter than the general workspace-name rule (no dots): a
 * fork name is generated as often as it is chosen, and the generated form is
 * `<source>-fork-<id>`.
 */
const FORK_NAME = /^[A-Za-z0-9_-]+$/;

/** How a fork reaches the workspace it is creating. */
export interface ForkTransport {
  /**
   * Whether a workspace by this name already holds data. Consulted only to turn
   * an EXPLICITLY requested name into an error instead of a silent overwrite; a
   * generated name that somehow collides falls through, because failing a fork
   * over a random-id collision helps nobody.
   *
   * A transport that cannot answer cheaply should answer `false` rather than
   * throw: the delivery below will surface a real problem anyway, and blocking
   * a fork on a brittle pre-check is worse than a late error.
   */
  occupied(name: string): Promise<boolean>;
  /** Land the snapshot in the named workspace and report its id. */
  deliver(name: string, snapshot: ForkSnapshot): Promise<{ workspaceId: string }>;
}

export interface ForkDriverDeps {
  /** The workspace filesystem a fork inherits SOUL.md and memory/ from. */
  readonly vfs: VFS;
  /** The source workspace's own SQL — where the snapshot is read from. */
  sql: SqlExecutor;
  transport: ForkTransport;
  /** The source workspace's name, the stem of a generated fork name. */
  sourceName: string;
  /** True while a turn is in flight. A cut taken mid-turn would snapshot a
   *  half-written conversation, so the fork is refused rather than skewed. */
  busy(): boolean;
}

/** Where the fork landed. The backend adds its own addressing (a URL, a path). */
export interface ForkOutcome {
  /** The new workspace's id, as the transport reports it. */
  workspaceId: string;
  name: string;
  /** Timestamp of the message the fork was cut at. */
  forkPointMs: number;
}

/**
 * Fork this workspace at a message, producing a new workspace whose messages,
 * SOUL.md, memory, crafted tools and config are copied and whose evolution
 * state (search tree, scaffold, craft scores) starts clean.
 *
 * Throws — rather than returning an error shape — because every failure here is
 * a caller mistake worth surfacing verbatim: a busy agent, an unknown cut
 * point, a malformed name, a name already taken.
 */
export async function forkWorkspace(
  deps: ForkDriverDeps,
  untilMessageId: string,
  opts?: { name?: string },
): Promise<ForkOutcome> {
  if (deps.busy()) {
    throw new Error('agent busy, retry when current turn finishes');
  }

  // Resolve the cut point FIRST, so an unknown message id costs nothing: the
  // snapshot throws on a missing id, and it is the cheapest thing here.
  const snapshot = await snapshotWorkspaceForFork(deps.sql, deps.vfs, untilMessageId);

  const requestedName = opts?.name?.trim();
  const name = requestedName && requestedName.length > 0
    ? requestedName
    : `${deps.sourceName}-fork-${nanoid(6)}`;
  if (!FORK_NAME.test(name)) {
    throw new Error(`invalid agent name: "${name}" — allowed: A-Z, a-z, 0-9, _ and -`);
  }
  if (requestedName && await deps.transport.occupied(name)) {
    throw new Error(`agent name already exists: "${name}"`);
  }

  const { workspaceId } = await deps.transport.deliver(name, snapshot);
  return { workspaceId, name, forkPointMs: snapshot.cut.createdAtMs };
}
