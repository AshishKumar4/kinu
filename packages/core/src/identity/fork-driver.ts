/** Workspace fork driver: backend-neutral; a backend supplies only a {@link ForkTransport}. */

import { workspaceAddressRefusal, workspaceSlug } from './naming';
import { forkPointExists } from './conversation-store';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from './actor-handle';
import type { ForkFileSource } from './fork-transfer';

/** How a fork reaches the workspace it is creating. */
export interface ForkTransport {
  /** Whether a workspace by this name already holds data. Checked only for an
   *  explicitly requested name; a transport that cannot answer cheaply returns `false`. */
  occupied(name: string): Promise<boolean>;
  /** Stream the source state into the named workspace; report where and at which cut point it landed. */
  deliver(name: string, source: {
    sql: SqlExecutor; vfs: ForkFileSource; untilMessageId: string; artifactDirectory: string;
  }): Promise<{
    workspaceId: string; forkPointMs: number;
  }>;
}

export interface ForkDriverDeps {
  /** The workspace files a fork inherits, as one snapshot. */
  readonly vfs: ForkFileSource;
  /** The source workspace's own SQL — where the snapshot is read from. */
  sql: SqlExecutor;
  /** Source payload directory; the carried conversation references payloads by absolute path. */
  readonly artifactDirectory: string;
  /** The actor whose transcript is cut. Message ids are per actor, so an unscoped
   *  preflight could admit a cut at a sibling's message. */
  readonly actor: ActorHandle;
  transport: ForkTransport;
  sourceName: string;
  /** True while a turn is in flight; a mid-turn cut would snapshot a half-written conversation. */
  busy(): boolean;
}

/** Where the fork landed. The backend adds its own addressing (a URL, a path). */
export interface ForkOutcome {
  workspaceId: string;
  name: string;
  /** Timestamp of the message the fork was cut at. */
  forkPointMs: number;
}

/**
 * Fork at a message: its conversation, crafted tools, config, and the workspace files as they are now; evolution state starts clean.
 * Throws on caller mistakes (busy agent, unknown cut point, bad or taken name).
 */
export async function forkWorkspace(
  deps: ForkDriverDeps,
  untilMessageId: string,
  opts?: { name?: string },
): Promise<ForkOutcome> {
  if (deps.busy()) {
    throw new Error('agent busy, retry when current turn finishes');
  }

  if (!forkPointExists(deps.sql, deps.actor, untilMessageId)) {
    throw new Error(`fork point not found: message id "${untilMessageId}" does not exist in source`);
  }

  const requestedName = opts?.name?.trim();

  const name = requestedName && requestedName.length > 0
    ? requestedName
    : workspaceSlug(crypto.randomUUID());

  const refusal = workspaceAddressRefusal(name);

  if (refusal !== null) throw new Error(`invalid agent name: ${refusal}`);

  if (requestedName && await deps.transport.occupied(name)) {
    throw new Error(`agent name already exists: "${name}"`);
  }

  const { workspaceId, forkPointMs } = await deps.transport.deliver(name, {
    sql: deps.sql, vfs: deps.vfs, untilMessageId, artifactDirectory: deps.artifactDirectory,
  });

  return { workspaceId, name, forkPointMs };
}
