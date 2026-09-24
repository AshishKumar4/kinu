/**
 * A fork as production runs one: the source's own frame stream (`forkTransferFrames`), each frame
 * structured-cloned as DO RPC clones it, into a `ForkTransferReceiver` over the target's writer.
 */

import {
  createWorkspaceForkSink, FORK_FRAME_BYTES, ForkTargetWriter, ForkTransferReceiver, forkTransferFrames, summarizeSoul, SOUL_PATH,
  type ForkFileSink, type ForkFileSource, type ForkFrame, type ForkResult, type ForkWriteTarget,
} from '../../src/index';
import type { ForkFileFrame } from '../../src/identity/fork-transfer';
import type { SqlExecutor } from '../../src/types/primitives';
import { openWorkspaceMainActor } from '../../src/identity/workspace-actors';
import type { TestWorkspace } from '../helpers';
import { SOURCE_ARTIFACTS } from './fork-conversation';

/** The store a fork reads from or lands in. */
interface ForkStore {
  readonly sql: SqlExecutor;
  readonly forkSource: ForkFileSource;
}

/** The source's frames for a cut, keyed on its main actor, as the source DO streams them. */
export function sourceFrames(src: ForkStore, untilMessageId: string, opts: {
  artifactDirectory?: string; transferId?: string; frameBytes?: number;
} = {}): Promise<ForkFrame[]> {
  return Array.fromAsync(forkTransferFrames({
    sql: src.sql, actor: openWorkspaceMainActor(src.sql), vfs: src.forkSource, untilMessageId,
    artifactDirectory: opts.artifactDirectory ?? SOURCE_ARTIFACTS,
    transferId: opts.transferId ?? 'tx-1',
    frameBytes: opts.frameBytes ?? FORK_FRAME_BYTES,
  }));
}

function isFileFrame(frame: ForkFrame): frame is ForkFileFrame {
  return frame.kind === 'file';
}

/** What a stream carried, section by section, with each file's ranges (or whole entry) joined back into text. */
export function reassemble(frames: readonly ForkFrame[]) {
  const begin = frames[0];

  if (begin?.kind !== 'begin') throw new Error('missing begin frame');
  const files = new Map<string, Uint8Array[]>();
  const artifacts = new Map<string, Uint8Array[]>();
  const directories: string[] = [];
  const symlinks: Array<{ path: string; target: string }> = [];

  for (const frame of frames) {
    if (frame.kind === 'entries') {
      for (const entry of frame.entries) {
        if (entry.kind === 'file') files.set(entry.path, [entry.bytes]);
        else if (entry.kind === 'directory') directories.push(entry.path);
        else symlinks.push({ path: entry.path, target: entry.target });
      }
    }

    if (!isFileFrame(frame)) continue;
    const into = frame.artifact ? artifacts : files;
    const ranges = into.get(frame.path) ?? [];
    ranges.push(frame.bytes);
    into.set(frame.path, ranges);
  }

  const decoder = new TextDecoder();

  const decode = (carried: Map<string, Uint8Array[]>): Array<{ path: string; content: string }> => [...carried]
    .map(([path, ranges]) => ({ path, content: decoder.decode(Bun.concatArrayBuffers(ranges)) }));

  return {
    source: begin.head.source,
    cut: begin.head.cut,
    agentConfig: frames.flatMap((frame) => (frame.kind === 'agentConfig' ? frame.rows : [])),
    craftedTools: frames.flatMap((frame) => (frame.kind === 'craftedTools' ? frame.rows : [])),
    memoryChunks: frames.flatMap((frame) => (frame.kind === 'memoryChunks' ? frame.rows : [])),
    sessionMessages: frames.flatMap((frame) => (frame.kind === 'sessionMessages' ? frame.rows : [])),
    conversationEntries: frames.flatMap((frame) => (frame.kind === 'conversationEntries' ? frame.rows : [])),
    conversationEntryParts: frames.flatMap((frame) => (frame.kind === 'conversationEntryParts' ? frame.rows : [])),
    contextMembers: frames.flatMap((frame) => (frame.kind === 'contextMembers' ? frame.rows : [])),
    files: decode(files),
    artifacts: decode(artifacts),
    directories,
    symlinks,
  };
}

export type ForkContent = ReturnType<typeof reassemble>;

/** A sink that reassembles each ranged file in memory and publishes it to the target's plane; whole
 *  entries, modes and removals go through the production sink. */
export function sinkFor(tgt: TestWorkspace): ForkFileSink {
  const ranges = new Map<string, Uint8Array[]>();
  const native = createWorkspaceForkSink(tgt.bundle, 'test-sink');

  return {
    async beginFile(path, staged) {
      // Nothing here persists or evicts, so an adopting call would be a test defect.
      if (staged !== 0) throw new Error(`test sink cannot adopt ${staged} staged bytes of ${path}`);
      ranges.set(path, []);
    },
    async writeRange(path, _offset, bytes) { ranges.get(path)?.push(bytes.slice()); },
    async stagedDigest(path, bytes) {
      const parts = ranges.get(path) ?? [];
      const size = parts.reduce((n, part) => n + part.byteLength, 0);

      if (size !== bytes) throw new Error(`test sink staged ${size} bytes of ${path}, not ${bytes}`);
      const hash = new Bun.CryptoHasher('sha256');

      for (const part of parts) hash.update(part);

      return hash.digest('hex');
    },
    async commitFile(path, meta) {
      const parts = ranges.get(path) ?? [];
      const size = parts.reduce((n, part) => n + part.byteLength, 0);
      const bytes = new Uint8Array(size);
      let at = 0;

      for (const part of parts) { bytes.set(part, at); at += part.byteLength; }

      ranges.delete(path);

      if (path === SOUL_PATH) {
        await tgt.vfs.writeFile(path, bytes);

        return { mission: summarizeSoul(new TextDecoder().decode(bytes)) };
      }

      // The reassembled file lands as a whole entry: the production write, mode and mtime.
      await native.place([{ kind: 'file', path, bytes, ...meta }]);

      return {};
    },
    async abortFile(path) { ranges.delete(path); },
    place: (entries) => native.place(entries),
    remove: (paths) => native.remove(paths),
  };
}

export function receiverFor(tgt: TestWorkspace, target: ForkWriteTarget): ForkTransferReceiver {
  return new ForkTransferReceiver(new ForkTargetWriter(tgt.sql, target), sinkFor(tgt));
}

/** Deliver every frame, each cloned as it crosses RPC; the fork the commit frame published. */
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
export async function streamFork(src: ForkStore, tgt: TestWorkspace, target: ForkWriteTarget, cut: {
  untilMessageId: string; artifactDirectory?: string; transferId?: string; frameBytes?: number;
}): Promise<ForkResult> {
  return deliver(receiverFor(tgt, target), await sourceFrames(src, cut.untilMessageId, cut));
}
