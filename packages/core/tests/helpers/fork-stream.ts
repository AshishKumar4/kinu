/**
 * A fork as production runs one: the source's own frame stream (`forkTransferFrames`), each frame structured-cloned
 * as DO RPC clones it into a `ForkTransferReceiver` over the target's writer, each answer passed back into the stream.
 */

import type { Database } from 'bun:sqlite';
import {
  createWorkspaceForkSink, FORK_FRAME_BYTES, ForkTargetWriter, ForkTransferReceiver, forkTransferFrames,
  type ForkFileSource, type ForkFrame, type ForkFrameReply, type ForkResult, type ForkWriteTarget,
} from '../../src/index';
import type { SqlExecutor } from '../../src/types/primitives';
import { openWorkspaceMainActor } from '../../src/identity/workspace-actors';
import { createAppDataStore, type AppDataStore } from '../../src/tools/db-codemode';
import { RunEventRecorder } from '../../src/events/recorder';
import { createTestWorkspace, type TestWorkspace } from '../helpers';
import { SOURCE_ARTIFACTS } from './fork-conversation';

/** The store a fork reads from or lands in. */
interface ForkStore {
  readonly sql: SqlExecutor;
  readonly db: Database;
  readonly forkSource: ForkFileSource;
}

/** A target's write options; the writer is handed the target's own `db` store. */
export type ForkTargetOptions = Omit<ForkWriteTarget, 'appData'>;

/** The `db` tool's store as `workspace`'s main actor uses it. */
export function appDataOf(workspace: Pick<ForkStore, 'sql' | 'db'>): AppDataStore {
  const actor = openWorkspaceMainActor(workspace.sql);

  return createAppDataStore({
    sql: workspace.sql, actor, transactionSync: (write) => workspace.db.transaction(write)(),
    events: () => new RunEventRecorder(workspace.sql, actor), runId: () => 'run-fork',
  });
}

interface Cut {
  readonly untilMessageId: string;
  readonly artifactDirectory?: string;
  readonly transferId?: string;
  readonly frameBytes?: number;
}

export function receiverFor(tgt: TestWorkspace, target: ForkTargetOptions): ForkTransferReceiver {
  return new ForkTransferReceiver(writerFor(tgt, target), createWorkspaceForkSink(tgt.bundle));
}

export function writerFor(tgt: TestWorkspace, target: ForkTargetOptions): ForkTargetWriter {
  return new ForkTargetWriter(tgt.sql, { ...target, appData: () => appDataOf(tgt).fork });
}

/** Run one transfer into `receiver`: every frame that crossed, and the fork the commit published (null if none). */
export async function transfer(
  src: ForkStore, receiver: ForkTransferReceiver, cut: Cut,
): Promise<{ frames: ForkFrame[]; result: ForkResult | null }> {
  const stream = forkTransferFrames({
    sql: src.sql, actor: openWorkspaceMainActor(src.sql), vfs: src.forkSource, untilMessageId: cut.untilMessageId,
    appData: appDataOf(src).fork,
    artifactDirectory: cut.artifactDirectory ?? SOURCE_ARTIFACTS,
    transferId: cut.transferId ?? 'tx-1',
    frameBytes: cut.frameBytes ?? FORK_FRAME_BYTES,
  });

  const frames: ForkFrame[] = [];
  let result: ForkResult | null = null;
  let reply: ForkFrameReply | undefined;

  try {
    for (let next = await stream.next(); !next.done; next = await stream.next(reply)) {
      frames.push(next.value);
      const outcome = await receiver.accept(structuredClone(next.value));

      reply = outcome.status === 'want' ? { want: outcome.hashes } : undefined;

      if (outcome.status === 'published') result = outcome.result;
    }
  } finally {
    await stream.return(undefined);
  }

  return { frames, result };
}

/** The source's frames for a cut, as they cross to a target that holds nothing yet. */
export async function sourceFrames(src: ForkStore, untilMessageId: string, opts: Omit<Cut, 'untilMessageId'> = {}): Promise<ForkFrame[]> {
  const target = createTestWorkspace();
  const receiver = receiverFor(target, { workspaceId: 'frames-target', workspaceName: 'frames-target', artifactDirectory: SOURCE_ARTIFACTS });

  return (await transfer(src, receiver, { ...opts, untilMessageId })).frames;
}

/** What a stream carried, section by section, with each file joined back from its rows' chunks. */
export function reassemble(frames: readonly ForkFrame[]) {
  const begin = frames[0];

  if (begin?.kind !== 'begin') throw new Error('missing begin frame');
  const chunks = new Map<string, Uint8Array>();

  for (const frame of frames) {
    if (frame.kind === 'chunks') for (const chunk of frame.chunks) chunks.set(chunk.hash, chunk.data);
  }

  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array[]>();
  const artifacts = new Map<string, Uint8Array[]>();
  const directories: string[] = [];
  const symlinks: Array<{ path: string; target: string }> = [];
  const pages = new Set<string>();

  for (const frame of frames) {
    if (frame.kind !== 'page') continue;
    // A page the target first wanted chunks for crosses twice; its rows count once.
    const key = `${JSON.stringify(frame.target)}|${frame.page.after ?? ''}`;

    if (pages.has(key)) continue;
    pages.add(key);

    for (const row of frame.page.rows) {
      const target = frame.target;
      const home = target.in === 'home';
      const base = target.in === 'home' ? target.name : target.path;
      const path = row.path === '' ? base : `${base}/${row.path}`;

      if (row.kind === 'directory') {
        directories.push(path);
        continue;
      }

      const bytes = row.pieces.map(([hash]) => {
        const data = chunks.get(hash);

        if (data === undefined) throw new Error(`no frame carried chunk ${hash} of ${path}`);

        return data;
      });

      if (row.kind === 'symlink') {
        symlinks.push({ path, target: decoder.decode(Bun.concatArrayBuffers(bytes)) });
        continue;
      }

      const into = home ? files : artifacts;
      into.set(path, [...(into.get(path) ?? []), ...bytes]);
    }
  }

  const decode = (carried: Map<string, Uint8Array[]>): Array<{ path: string; content: string }> => [...carried]
    .map(([path, parts]) => ({ path, content: decoder.decode(Bun.concatArrayBuffers(parts)) }));

  return {
    source: begin.head.source,
    cut: begin.head.cut,
    agentConfig: frames.flatMap((frame) => (frame.kind === 'agentConfig' ? frame.rows : [])),
    craftedTools: frames.flatMap((frame) => (frame.kind === 'craftedTools' ? frame.rows : [])),
    sessionMessages: frames.flatMap((frame) => (frame.kind === 'sessionMessages' ? frame.rows : [])),
    conversationEntries: frames.flatMap((frame) => (frame.kind === 'conversationEntries' ? frame.rows : [])),
    conversationEntryParts: frames.flatMap((frame) => (frame.kind === 'conversationEntryParts' ? frame.rows : [])),
    contextMembers: frames.flatMap((frame) => (frame.kind === 'contextMembers' ? frame.rows : [])),
    lessons: frames.flatMap((frame) => (frame.kind === 'lessons' ? frame.rows : [])),
    toolLessons: frames.flatMap((frame) => (frame.kind === 'toolLessons' ? frame.rows : [])),
    facts: frames.flatMap((frame) => (frame.kind === 'facts' ? frame.rows : [])),
    appTables: frames.flatMap((frame) => (frame.kind === 'appTables' ? frame.rows : [])),
    appRows: frames.flatMap((frame) => (frame.kind === 'appRows' ? frame.rows : [])),
    files: decode(files),
    artifacts: decode(artifacts),
    directories,
    symlinks,
  };
}

export type ForkContent = ReturnType<typeof reassemble>;

/** Deliver recorded frames, each cloned as it crosses RPC; the fork the commit frame published. */
export async function deliver(receiver: ForkTransferReceiver, frames: readonly ForkFrame[]): Promise<ForkResult> {
  let landed: ForkResult | null = null;

  for (const frame of frames) {
    const outcome = await receiver.accept(structuredClone(frame));

    if (outcome.status === 'published') landed = outcome.result;
  }

  if (landed === null) throw new Error('the transfer never published');

  return landed;
}

/** Fork `src` at `cut.untilMessageId` into `tgt` over the production stream. */
export async function streamFork(src: ForkStore, tgt: TestWorkspace, target: ForkTargetOptions, cut: Cut): Promise<ForkResult> {
  const { result } = await transfer(src, receiverFor(tgt, target), cut);

  if (result === null) throw new Error('the transfer never published');

  return result;
}
