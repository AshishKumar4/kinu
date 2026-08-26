/**
 * Strategy three: a content-addressed overlay.
 *
 * attach     mount the prefix's materialized `tree/` read-only as the lower,
 *            lay a fresh native fuse-overlayfs upper on it, and replay only
 *            the journal entries newer than the folded cursor onto that upper.
 *            Recovery is O(pending change), not O(tree).
 * checkpoint('tick')
 *            scan the upper, stage new chunk blobs, append ONE journal object
 *            per batch of 64 entries. Blob before journal. Does not fold.
 *            Class-A cost is (new chunk blobs) + ceil(p / 64), never one PUT
 *            per changed path: an npm-shaped tick touches thousands of paths
 *            and almost none of their bytes.
 * checkpoint('quiesce')
 *            the tick, then fold the journal into `tree/` and advance the
 *            cursor. Journal before fold, fold before cursor, cursor before
 *            the reap.
 * discard    delete the prefix.
 *
 * MEASURED LOCAL, 2026-08-24, labelled LOCAL. Docker + minio + kernel overlay
 * + local squashfs tools. No Worker, no Durable Object, no Container, no R2.
 * `wrangler dev --remote` cannot host those and is not a substitute. The
 * milliseconds do not travel; the shape does.
 *
 *   Recovery with pending held at ~20 files (prototype `.results/`):
 *     16 MiB tree  — overlay 8 ms, squashfs extract 13 ms, image 2.55 MiB
 *     78 MiB tree  — overlay 6 ms, squashfs extract 59 ms, image 12.8 MiB
 *     235 MiB tree — overlay 6 ms, squashfs extract 146 ms, image 38.3 MiB
 *   Tree grew 14.7×; recovery stayed flat.
 *
 *   LOCAL invariants: native 15 hold / 0 fail / 1 unsupported; s3fs 13 / 1 / 2.
 *   After fold, a restore replayed 0 entries and fetched 720 B (cursor +
 *   manifest). A rename uploaded 0 content bytes (blob reuse).
 *
 */


import { describeThrown as describe, findMount } from './lifecycle';
import { isOverlayMounted, shouldCheckpoint } from './snapshot-chain';
import {
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStorage,
  recordCheckpointFailure,
} from './storage';
import {
  CHUNK_SIZE,
  appendJournalBatch,
  foldJournalIntoTree,
  replayPending,
  stageBlobs,
  stampEntries,
  sweepOrphanBlobs,
  type CasStore,
  type FileDigest,
  type JournalEntry,
  type NewJournalEntry,
} from './cas';
import {
  OVERLAY_CAS_STATE_MAX_BYTES,
  capSignatures,
  overlayCasStateBytes,
  type OverlayCasState,
  type UpperSignature,
} from './cas/state';
import { byApplyOrder, PendingJournalState } from './cas/pending-state';


/** Base64 both ways. The exec rail carries text, so every byte that crosses it
 *  is framed; raw binary in stdout is silently corrupted on the way back. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** Where this box's `tree/` prefix is mounted read-only inside the container. */
export const CAS_TREE_MOUNT = `${DEVBOX_RUNTIME_DIR}/cas-lower`;

const upperDir = `${DEVBOX_RUNTIME_DIR}/cas-upper`;
const workDir = `${DEVBOX_RUNTIME_DIR}/cas-work`;


export interface OverlayCasPorts {
  containerRunning(): boolean;
  /**
   * Run one shell command container-side.
   *
   * THE ONLY CONTAINER-SHELL PORT, for the reason the chain gives: the upper
   * walk, the whiteout form and the chunk read are this strategy's own
   * vocabulary, so it builds them itself rather than handing a host a set of
   * templates that host would then have to keep correct.
   *
   * NEVER carries raw binary. Non-UTF-8 bytes in stdout are corrupted silently
   * on the way back, so every byte this strategy reads through here is base64.
   */
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * Write bytes into the container, base64-framed. Maps to the SDK's own
   * `writeFile(path, content, { encoding: 'base64' })`; there is no other
   * DO-to-container byte rail.
   */
  writeFileBase64(path: string, base64: string): Promise<void>;
  /** Write a replayed file as a raw binary stream. The SDK's stream transport
   * keeps memory at one CAS chunk and avoids base64 expansion. */
  writeFileStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void>;
  /**
   * Mount this box's `tree/` prefix read-only at {@link CAS_TREE_MOUNT}.
   * Credentials never leave the Durable Object. Release through the SDK
   * (`unmountBucket`), never a raw fusermount3: the SDK keeps its own registry.
   */
  mountTree(): Promise<void>;
  unmountTree(): Promise<void>;
  store(): CasStore;
  inventory(): Promise<{ objects: number; bytes: number }>;
  clearPrefix(): Promise<number>;
  readState(): Promise<OverlayCasState | null>;
  writeState(state: OverlayCasState): Promise<void>;
  clearState(): Promise<void>;
  checkpointIntervalMs(): number;
  now(): number;
  log(message: string): void;
}

function shellPath(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

// ── the container shell ─────────────────────────────────────────────────────
//
// Every command this strategy runs, in this file, for the reason the chain
// states: a host supplies the ability to run a command; what to run is not its
// business. These were three ports on the adapter, which is the shape the
// chain deleted.

/** The overlayfs marker a directory carries when it replaced a lower one. */
const OPAQUE_MARKER = '.wh..wh..opq';
/** The overlayfs marker-file whiteout prefix, used where mknod is refused. */
const WHITEOUT_PREFIX = '.wh.';

/**
 * One record of the upper walk, before it is classified.
 *
 * NUL-separated FIELDS, not tab-separated. NUL is the one byte a POSIX
 * filename cannot contain, so a path holding a newline or a tab — which a
 * build script really does produce — cannot corrupt the record boundary.
 */
export interface UpperWalkRecord {
  readonly type: string;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly target: string;
  readonly path: string;
}

const WALK_FIELDS = 7;

/** Parse `find -printf '%y\0%m\0%s\0%T@\0%n\0%l\0%p\0'`. Exported because it
 *  is the one piece of the walk with real logic in it, and a parser nothing
 *  tests is a parser that silently mis-reads a production tree. */
export function parseUpperWalk(stdout: string): readonly UpperWalkRecord[] {
  const fields = stdout.split('\0');
  const records: UpperWalkRecord[] = [];
  for (let at = 0; at + WALK_FIELDS <= fields.length; at += WALK_FIELDS) {
    const path = fields[at + 6] ?? '';
    if (path === '') continue;
    records.push({
      type: fields[at] ?? '',
      mode: Number.parseInt(fields[at + 1] ?? '0', 8),
      size: Number(fields[at + 2] ?? '0'),
      mtimeMs: Math.round(Number(fields[at + 3] ?? '0') * 1000),
      nlink: Number(fields[at + 4] ?? '1'),
      target: fields[at + 5] ?? '',
      path,
    });
  }
  return records;
}

/**
 * The container-replacement hazard, named where it bites.
 *
 * A scan is two RPCs — walk, then hash the changed paths — and a spot
 * container can be replaced between them. On the fresh container the upper
 * does not exist, so the walk returns nothing. Read as an emptied workspace
 * that is a tombstone for every pending path, which is the mass-deletion
 * defect wearing a different hat. So the walk reports the upper's EXISTENCE
 * separately from its contents, and a missing upper refuses instead.
 */
export class UpperVanished extends Error {
  constructor(dir: string) {
    super(
      `the overlay upper ${dir} does not exist, so this container is not the one that was `
      + 'attached. Refusing to read an absent upper as an emptied workspace, which would '
      + 'journal a delete for every pending path.',
    );
    this.name = 'UpperVanished';
  }
}
/** Where the digest script is written before it is run. Rewritten each time it
 *  is needed rather than probed for: the container is ephemeral and a stale
 *  copy from a previous generation is not worth reasoning about. */
const DIGEST_SCRIPT_PATH = `${DEVBOX_RUNTIME_DIR}/cas-digest.sh`;

/** Paths per invocation. Bounded so a large changed set cannot approach
 *  ARG_MAX, and small enough that one refusal loses little work. */
const DIGEST_BATCH = 64;

/**
 * Emit, per readable file: `F\0<path>\0<size>\0<whole-hash>\0` then one
 * `C\0<chunk-hash>\0<chunk-size>\0` per {@link CHUNK_SIZE} chunk, in order.
 *
 * NUL-delimited with a leading tag per record, so a variable number of chunks
 * needs no length prefix and a path containing any legal byte cannot be
 * mis-split. `split --filter` runs the command once per chunk with the chunk
 * on stdin, which is how the per-chunk hashes are produced in ONE pass over
 * the bytes rather than one pass per chunk.
 */
const DIGEST_SCRIPT = `#!/bin/sh
for f in "$@"; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f")
  whole=$(sha256sum -- "$f" | cut -c1-64)
  printf 'F\\0%s\\0%s\\0%s\\0' "$f" "$size" "$whole"
  split -b ${CHUNK_SIZE} --filter='h=$(sha256sum | cut -c1-64); printf "C\\0%s\\0" "$h"' -- "$f"
done
`;

/**
 * Parse the digest stream into a per-path chunk list.
 *
 * `split --filter` cannot report the size it fed the command, so chunk sizes
 * are derived from the file size and {@link CHUNK_SIZE}: every chunk is full
 * except the last. That is the same arithmetic the reader uses to fetch a
 * chunk, so the two cannot disagree.
 */
export function parseDigestStream(stdout: string): ReadonlyMap<string, FileDigest> {
  const fields = stdout.split('\0');
  const digests = new Map<string, FileDigest>();
  let path: string | undefined;
  let size = 0;
  let whole = '';
  let chunks: { hash: string; size: number }[] = [];
  const flush = (): void => {
    if (path === undefined) return;
    digests.set(path, { hash: whole, size, chunks });
  };
  for (let at = 0; at < fields.length; at += 1) {
    if (fields[at] === 'F' && at + 3 < fields.length) {
      flush();
      path = fields[at + 1] ?? '';
      size = Number(fields[at + 2] ?? '0');
      whole = fields[at + 3] ?? '';
      chunks = [];
      at += 3;
      continue;
    }
    if (fields[at] === 'C' && at + 1 < fields.length && path !== undefined) {
      const hash = fields[at + 1] ?? '';
      const offset = chunks.length * CHUNK_SIZE;
      if (hash.length === 64) {
        chunks.push({ hash, size: Math.min(CHUNK_SIZE, Math.max(0, size - offset)) });
      }
      at += 1;
    }
  }
  flush();
  // A file whose chunk records did not add up to its length was read while it
  // was being written. Dropping it is what the caller's "vanished" branch
  // already handles, and it is safer than naming a chunk list that is short.
  for (const [key, digest] of digests) {
    const total = digest.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
    if (total !== digest.size || digest.hash.length !== 64) digests.delete(key);
  }
  return digests;
}


function casShell(ports: OverlayCasPorts) {
  const must = async (doing: string, command: string): Promise<string> => {
    const result = await ports.exec(command);
    if (result.exitCode !== 0) {
      throw new Error(`${doing} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };

  /**
   * Digest the paths whose cheap signature changed, and only those.
   *
   * The container computes BOTH the whole-file hash and the per-chunk hashes,
   * because the Durable Object cannot hash bytes it has not moved, and moving
   * them to decide whether to move them is the thing this design exists to
   * avoid. Cost is bounded by the CHANGED set, not the tree.
   *
   * The script is written to the container rather than inlined, so `--filter`
   * can carry its own quotes instead of being escaped through three layers of
   * shell. Paths arrive as arguments in batches, so no path is ever parsed out
   * of a stream where a newline could split it.
   *
   * A path that vanished before it was read yields no record. Ordinary, not an
   * error: the container may have been replaced between the walk and this
   * call, and the caller drops the entry rather than journalling it.
   */
  const digestChanged = async (
    paths: readonly string[],
  ): Promise<ReadonlyMap<string, FileDigest>> => {
    const digests = new Map<string, FileDigest>();
    if (paths.length === 0) return digests;
    await ports.writeFileBase64(DIGEST_SCRIPT_PATH, encodeBase64(
      new TextEncoder().encode(DIGEST_SCRIPT),
    ));
    for (let at = 0; at < paths.length; at += DIGEST_BATCH) {
      const batch = paths.slice(at, at + DIGEST_BATCH);
      const digestCommand = `sh ${shellPath(DIGEST_SCRIPT_PATH)} `
        + `${batch.map(shellPath).join(' ')} | base64 -w0`;
      const encoded = await must(
        'digesting changed upper files',
        `bash -o pipefail -c ${shellPath(digestCommand)}`,
      );
      const stdout = new TextDecoder().decode(decodeBase64(encoded.trim()));
      for (const [path, digest] of parseDigestStream(stdout)) digests.set(path, digest);
    }
    return digests;
  };

  return {
    readMounts: async (): Promise<string> => (await ports.exec('cat /proc/mounts')).stdout,

    pathExists: async (path: string): Promise<boolean> =>
      (await ports.exec(`test -e ${shellPath(path)} && echo yes || echo no`)).stdout.trim() === 'yes',

    /**
     * Classify the upper into journal entries.
     *
     * Two execs: the walk, then the hashes of what the cheap signature says
     * changed. A file whose mode, size and mtime all match its previous
     * signature is NOT re-read.
     */
    scanUpper: async (previous: ReadonlyMap<string, UpperSignature>): Promise<{
      entries: readonly NewJournalEntry[];
      signatures: ReadonlyMap<string, UpperSignature>;
    }> => {
      // The upper's existence and its contents in ONE exec, so a replacement
      // between two calls cannot make an absent upper look like an empty one.
      //
      // ABSENT AND FAILED ARE DIFFERENT FACTS. The first version chained find
      // into the same && as test -d, so ANY traversal error — a file the
      // workload deleted between listing and stat, ESTALE on the fuse mount —
      // printed UPPER-GONE and this code refused claiming the container had
      // been replaced, while /proc/mounts showed the upper present. Deployed
      // symptom, abc-3: every checkpoint refused while a later probe answered
      // yes. test -d failing means vanished; find failing means the walk must
      // be redone, and its own words say why.
      const walkCommand = `find ${shellPath(upperDir)} -mindepth 1 `
        + `-printf '%y\\0%m\\0%s\\0%T@\\0%n\\0%l\\0%p\\0' | base64 -w0`;
      const walked = await ports.exec(
        `if ! test -d ${shellPath(upperDir)}; then printf 'UPPER-GONE'; exit 0; fi; `
        + `encoded=$(bash -o pipefail -c ${shellPath(walkCommand)}) || exit $?; `
        + `printf 'UPPER-OK:%s' "$encoded"`,
      );
      // The executor's stdout channel is text and the deployed container
      // transport terminates a string at NUL. Base64 crosses that boundary;
      // NUL remains the path-safe delimiter only INSIDE the decoded payload.
      if (walked.stdout.startsWith('UPPER-GONE')) throw new UpperVanished(upperDir);
      if (walked.exitCode !== 0) {
        throw new Error(
          `walk of ${upperDir} failed (${walked.exitCode}): `
          + `${walked.stderr.trim() || walked.stdout.trim() || 'no diagnostic'}`,
        );
      }
      if (!walked.stdout.startsWith('UPPER-OK:')) {
        throw new Error(`walk of ${upperDir} returned no transport marker`);
      }
      const encodedWalk = walked.stdout.slice('UPPER-OK:'.length).trim();
      const records = parseUpperWalk(
        new TextDecoder().decode(decodeBase64(encodedWalk)),
      );

      const relative = (absolute: string): string => absolute.slice(upperDir.length + 1);
      const opaqueDirs = new Set<string>();
      const entries: NewJournalEntry[] = [];
      const signatures = new Map<string, UpperSignature>();
      const files: UpperWalkRecord[] = [];

      for (const record of records) {
        const path = relative(record.path);
        const name = path.slice(path.lastIndexOf('/') + 1);
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

        if (name === OPAQUE_MARKER) {
          opaqueDirs.add(parent);
          continue;
        }
        // A character device in an overlay upper is a whiteout. Nothing else
        // creates one there, and an object store has no representation for a
        // real device node anyway.
        if (record.type === 'c') {
          entries.push({ kind: 'delete', path });
          continue;
        }
        if (name.startsWith(WHITEOUT_PREFIX)) {
          const hidden = name.slice(WHITEOUT_PREFIX.length);
          entries.push({ kind: 'delete', path: parent === '' ? hidden : `${parent}/${hidden}` });
          continue;
        }
        if (record.type === 'l') {
          signatures.set(path, {
            kind: 'symlink',
            mode: record.mode,
            mtimeMs: record.mtimeMs,
            size: record.size,
            target: record.target,
          });
          const before = previous.get(path);
          if (before?.kind === 'symlink' && before.target === record.target) continue;
          entries.push({
            kind: 'symlink', path, target: record.target, mode: record.mode,
            mtimeMs: record.mtimeMs,
          });
          continue;
        }
        if (record.type === 'd') continue;
        if (record.type === 'f') {
          files.push(record);
        }
        // Sockets, fifos and real device nodes are skipped: an object store has
        // no representation for them and inventing one would be a silent lie.
      }

      // Directories second, so a directory's opacity is known before it is
      // emitted: the marker file that declares it may be walked after it.
      for (const record of records) {
        if (record.type !== 'd') continue;
        const path = relative(record.path);
        const opaque = opaqueDirs.has(path);
        signatures.set(path, {
          kind: 'dir', mode: record.mode, mtimeMs: record.mtimeMs, size: 0,
        });
        const before = previous.get(path);
        // An opaque marker is re-emitted every scan: it is a one-shot
        // instruction to the fold, not a steady state, and losing it would
        // resurrect the children it replaced.
        if (!opaque && before?.kind === 'dir' && before.mode === record.mode) continue;
        entries.push({
          kind: 'dir', path, mode: record.mode, mtimeMs: record.mtimeMs, opaque,
        });
      }

      const changed: string[] = [];
      for (const record of files) {
        const path = relative(record.path);
        const before = previous.get(path);
        const looksIdentical = before?.kind === 'file'
          && before.mode === record.mode
          && before.size === record.size
          && before.mtimeMs === record.mtimeMs
          && before.hash !== undefined;
        if (looksIdentical) {
          signatures.set(path, before);
          continue;
        }
        changed.push(record.path);
      }

      const digests = await digestChanged(changed);
      for (const record of files) {
        const path = relative(record.path);
        const digest = digests.get(record.path);
        // No digest means the path was gone, or still being written, when it
        // was read. Ordinary: the container may have been replaced. It is
        // neither journalled nor tombstoned, and its previous signature is not
        // carried forward, so the next scan looks again.
        if (digest === undefined) continue;
        signatures.set(path, {
          kind: 'file',
          mode: record.mode,
          mtimeMs: record.mtimeMs,
          size: digest.size,
          hash: digest.hash,
        });
        entries.push({
          kind: 'file',
          path,
          mode: record.mode,
          mtimeMs: record.mtimeMs,
          size: digest.size,
          hash: digest.hash,
          chunks: digest.chunks,
        });
      }

      entries.sort(byApplyOrder);
      return { entries, signatures };
    },

    /**
     * One chunk of an upper file, base64 through the shell.
     *
     * Never the whole file: a multi-chunk file read whole would put its entire
     * length in the Durable Object's memory, and the isolate's budget is the
     * bound this strategy has to respect. `tail | head` rather than `dd` flags
     * so the byte offsets are POSIX rather than coreutils-specific.
     */
    readUpperChunk: async (
      path: string, index: number, size: number,
    ): Promise<Uint8Array | null> => {
      const absolute = `${upperDir}/${path}`;
      const offset = index * CHUNK_SIZE;
      const result = await ports.exec(
        `test -f ${shellPath(absolute)} && tail -c +${offset + 1} ${shellPath(absolute)} `
        + `| head -c ${size} | base64 -w0`,
      );
      if (result.exitCode !== 0) return null;
      const decoded = decodeBase64(result.stdout.trim());
      return decoded.byteLength === size ? decoded : null;
    },

    /** Write one replayed entry into the upper. A delete becomes a whiteout. */
    materialize: async (
      entry: JournalEntry,
      stream: ReadableStream<Uint8Array> | null,
    ): Promise<void> => {
      const absolute = `${upperDir}/${entry.path}`;
      const parent = absolute.slice(0, absolute.lastIndexOf('/'));
      switch (entry.kind) {
        case 'dir': {
          const opaque = entry.opaque
            ? ` && : > ${shellPath(`${absolute}/${OPAQUE_MARKER}`)}`
            : '';
          await must(
            `materializing directory ${entry.path}`,
            `mkdir -p ${shellPath(absolute)} && chmod ${entry.mode.toString(8)} `
            + `${shellPath(absolute)}${opaque}`,
          );
          return;
        }
        case 'file': {
          if (stream === null) throw new Error(`file entry replayed without a stream: ${entry.path}`);
          await must(`preparing ${entry.path}`, `mkdir -p ${shellPath(parent)}`);
          await ports.writeFileStream(absolute, stream);
          await must(
            `setting metadata on ${entry.path}`,
            `chmod ${entry.mode.toString(8)} ${shellPath(absolute)} && touch -m -d `
              + `@${String(entry.mtimeMs / 1000)} -- ${shellPath(absolute)}`,
          );
          return;
        }
        case 'symlink': {
          await must(
            `materializing symlink ${entry.path}`,
            `mkdir -p ${shellPath(parent)} && ln -sfn ${shellPath(entry.target)} `
              + `${shellPath(absolute)} && touch -h -m -d @${String(entry.mtimeMs / 1000)} `
              + `-- ${shellPath(absolute)}`,
          );
          return;
        }
        case 'delete': {
          const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
          // mknod first, marker second. Which form the kernel and this mount
          // accept is not knowable from here, and one command that tries both
          // is one RPC rather than a probe plus a write.
          await must(
            `whiting out ${entry.path}`,
            `mkdir -p ${shellPath(parent)} && rm -rf ${shellPath(absolute)} && `
            + `{ mknod ${shellPath(absolute)} c 0 0 2>/dev/null || `
            + `: > ${shellPath(`${parent}/${WHITEOUT_PREFIX}${name}`)}; }`,
          );
          return;
        }
        default: {
          // A kind with no arm here would be silently NOT replayed, so the
          // upper would come back missing a change the journal recorded.
          const unknown: never = entry;
          throw new Error(
            `journal entry has a kind this replay does not handle: ${JSON.stringify(unknown)}`,
          );
        }
      }
    },
    restampDirectory: async (entry: Extract<JournalEntry, { kind: 'dir' }>): Promise<void> => {
      const absolute = `${upperDir}/${entry.path}`;
      await must(
        `restamping directory ${entry.path}`,
        `chmod ${entry.mode.toString(8)} ${shellPath(absolute)} && touch -m -d `
          + `@${String(entry.mtimeMs / 1000)} -- ${shellPath(absolute)}`,
      );
    },
  };
}


export function overlayCasStorage(ports: OverlayCasPorts): DevboxStorage {
  const shell = casShell(ports);
  const pendingState = new PendingJournalState();

  /**
   * Did the overlay really land, with both of its layers on THIS container's
   * disk?
   *
   * ONE exec, not three. Only `/workspace` is supplied by the image; everything
   * under `DEVBOX_RUNTIME_DIR` is ours and vanishes when a spot container is
   * replaced. Three separate probes are three chances for a replacement to land
   * between them, and the answers would then describe two different containers.
   * Asked together, the answer is about one disk at one instant.
   */
  const assertOverlayLanded = async (what: string): Promise<void> => {
    if (!isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
      throw new Error(
        `attach of ${DEVBOX_WORKDIR} for ${what} reported success, but ${DEVBOX_WORKDIR} `
        + 'is not an overlay mount.',
      );
    }
    const probe = await ports.exec(
      `test -d ${shellPath(upperDir)} && echo upper; test -d ${shellPath(CAS_TREE_MOUNT)} `
      + '&& echo lower',
    );
    const seen = probe.stdout.split('\n').map(line => line.trim());
    if (!seen.includes('upper')) {
      throw new Error(
        `attach of ${DEVBOX_WORKDIR} for ${what} produced an overlay whose upper directory `
        + `${upperDir} does not exist, so nothing the caller writes could be checkpointed. `
        + 'Only /workspace is supplied by the image; this path is ours and does not survive '
        + 'a container replacement.',
      );
    }
    if (!seen.includes('lower')) {
      throw new Error(
        `attach of ${DEVBOX_WORKDIR} for ${what} produced an overlay whose lower `
        + `${CAS_TREE_MOUNT} does not exist.`,
      );
    }
  };

  /**
   * Bring the upper up to the journal, and say how many entries that took.
   *
   * RUN BEFORE THE OVERLAY LANDS, which is what makes the ordering do the work
   * instead of a repair. The upper is an ordinary directory until fuse-overlayfs
   * takes it as a parameter, so nothing requires the overlay to exist first.
   *
   * The state this removes: a replay is many RPCs, so one can throw with the
   * overlay already up. An attach that mounted FIRST then left a half-replayed
   * upper behind, and the next attach saw a mounted overlay and early-returned
   * over it — a workspace silently missing changes the journal had recorded,
   * reporting an outcome that reads like success. Mounting LAST makes "the
   * overlay is mounted" imply "the replay finished", so the early return below
   * is correct by construction and needs no marker and no re-check.
   */
  const replayOntoUpper = async (): Promise<number> => {
    const replayed = await replayPending(ports.store());
    for (const item of replayed.replayed) {
      await shell.materialize(item.entry, item.stream);
    }
    const directories = replayed.replayed
      .map(item => item.entry)
      .filter((entry): entry is Extract<JournalEntry, { kind: 'dir' }> => entry.kind === 'dir')
      .sort((a, b) => b.path.split('/').length - a.path.split('/').length);
    for (const directory of directories) await shell.restampDirectory(directory);
    return replayed.pending.length;
  };

  const attach = async (): Promise<AttachOutcome> => {
    if (isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
      // Nothing to replay: the overlay only lands after the replay finishes,
      // so a mounted overlay is itself the evidence that it did.
      const held = await ports.inventory();
      ports.log(`${DEVBOX_WORKDIR} already attached — attach skipped`);
      return {
        kind: 'already-attached',
        detail: `overlay-cas ${held.objects} objects ${held.bytes}B`,
      };
    }

    await ports.unmountTree();
    // The exit code is CHECKED. It used to be discarded, so a failed setup ran
    // on to the mount and surfaced two RPCs later as "cas-upper does not exist"
    // — a refusal naming the symptom while the container's own words about the
    // cause were thrown away.
    const prepared = await ports.exec(
      `mkdir -p ${shellPath(CAS_TREE_MOUNT)} ${shellPath(upperDir)} ${shellPath(workDir)} `
      + `${shellPath(DEVBOX_WORKDIR)}`,
    );
    if (prepared.exitCode !== 0) {
      throw new Error(
        `overlay-cas could not create its runtime directories under ${DEVBOX_RUNTIME_DIR}: `
        + `${prepared.stderr.trim() || prepared.stdout.trim() || `exit ${prepared.exitCode}`}`,
      );
    }
    const pending = await replayOntoUpper();
    try {
      await ports.mountTree();
    } catch (error) {
      throw new Error(
        `overlay-cas tree/ could not be mounted at ${CAS_TREE_MOUNT}: `
        + describe({ cause: error }),
        { cause: error },
      );
    }
    // mkdir of the mountpoint is already done; the overlay mount itself is one
    // command so a spot replacement cannot land between the two.
    const mounted = await ports.exec(
      `mkdir -p ${shellPath(upperDir)} ${shellPath(workDir)} && /usr/bin/fuse-overlayfs `
      + `-o lowerdir=${shellPath(CAS_TREE_MOUNT)}`
      + `,upperdir=${shellPath(upperDir)},workdir=${shellPath(workDir)} `
      + `${shellPath(DEVBOX_WORKDIR)}`,
    );
    if (mounted.exitCode !== 0) {
      throw new Error(
        `fuse-overlayfs attach of ${DEVBOX_WORKDIR} failed: `
        + `${mounted.stderr.trim() || mounted.stdout.trim()}`,
      );
    }
    await assertOverlayLanded('overlay-cas');

    const held = await ports.inventory();
    ports.log(
      `${DEVBOX_WORKDIR} attached (overlay-cas, ${held.objects} objects, ${held.bytes}B, `
      + `${pending} pending replayed before the mount)`,
    );
    if (held.objects === 0 && pending === 0) {
      return { kind: 'empty', detail: 'overlay-cas empty overlay attached' };
    }
    return {
      kind: 'attached',
      detail: `overlay-cas ${held.objects} objects ${held.bytes}B ${pending}P`,
    };
  };

  const checkpoint = async (kind: CheckpointKind): Promise<CheckpointOutcome> => {
    if (!ports.containerRunning()) {
      return { kind: 'skipped', reason: 'container is not running', bytes: undefined, movedBytes: 0 };
    }
    const previous = await ports.readState();
    if (!isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
      // Through recordFailure like every other refusal, so the reason reaches
      // durable state. A repeatedly unattached box is exactly the one whose
      // failures have to stay visible after the object is evicted.
      return await recordCheckpointFailure(
        ports,
        previous,
        `${DEVBOX_WORKDIR} is not an overlay mount, so nothing written there reaches the `
        + 'journal. Refusing to report a checkpoint for a work directory that is not attached.',
      );
    }
    const signatures = new Map(Object.entries(previous?.signatures ?? {}));
    const store = ports.store();

    // The journal, not the signature cache, is the correctness record for an
    // upper-only path. A cached row may be evicted; a pending create may not.
    let fresh: readonly NewJournalEntry[];
    let scanned: ReadonlyMap<string, UpperSignature>;
    try {
      await pendingState.load(store);
      const scan = await shell.scanUpper(signatures);
      const currentPaths = new Set(scan.signatures.keys());
      const tombstoned = new Set(
        scan.entries.filter(entry => entry.kind === 'delete').map(entry => entry.path),
      );
      const changed = pendingState.filterChanged(scan.entries);
      fresh = [...changed, ...pendingState.vanished(currentPaths, tombstoned)];
      scanned = scan.signatures;
    } catch (error) {
      pendingState.invalidate();
      return await recordCheckpointFailure(ports, previous, describe({ cause: error }));
    }

    // Nothing changed is the more specific fact, so it is reported ahead of the
    // interval. A tick that says "within the interval" about an idle directory
    // invites the next reader to raise the interval to fix a non-problem.
    if (kind === 'tick' && fresh.length === 0) {
      const held = await ports.inventory();
      if (held.objects === 0) {
        return {
          kind: 'skipped',
          reason: `${DEVBOX_WORKDIR} holds no objects yet`,
          bytes: undefined,
          movedBytes: 0,
        };
      }
      return { kind: 'skipped', reason: 'work directory is unchanged', bytes: undefined, movedBytes: 0 };
    }

    if (kind === 'tick'
      && !shouldCheckpoint('changed', previous?.lastCheckpointAt ?? 0, ports.now(),
        ports.checkpointIntervalMs())) {
      return {
        kind: 'skipped',
        reason: 'within the minimum checkpoint interval',
        bytes: undefined,
        movedBytes: 0,
      };
    }

    try {
      const stamped = stampEntries(fresh, pendingState.sequence());

      const worstSignatures = new Map<string, UpperSignature>();
      for (const [path, signature] of Object.entries(previous?.signatures ?? {})) {
        worstSignatures.set(path, signature);
      }
      for (const [path, signature] of scanned) worstSignatures.set(path, signature);
      const boundedWorstSignatures = capSignatures(worstSignatures);
      const worstBytes = overlayCasStateBytes(boundedWorstSignatures);
      if (worstBytes > OVERLAY_CAS_STATE_MAX_BYTES) {
        return await recordCheckpointFailure(
          ports,
          previous,
          `the bounded overlay-cas state row would hold ${worstBytes} bytes across `
            + `${boundedWorstSignatures.size} cached paths; this strategy refuses one state `
            + `value over ${OVERLAY_CAS_STATE_MAX_BYTES} bytes (half the Durable Object `
            + 'per-value ceiling). Nothing was journalled.',
        );
      }

      // The manifest plus pending journal is the exact reachable set. Fold
      // invalidates this cache before GC can delete anything it names.
      const known = pendingState.blobHashes();
      const countersBefore = { ...store.counters };
      let journalBytesPut = 0;
      // Journal objects are written PER BATCH, inside commitBatch, so they land
      // only after that batch's blobs are durable. A crash therefore redoes one
      // batch rather than losing the whole change set. The counter capture
      // around each append lets movedBytes report BLOB bytes alone below.
      const staged = await stageBlobs({
        store,
        entries: stamped,
        readChunk: (entry, index, size) => shell.readUpperChunk(entry.path, index, size),
        known,
        commitBatch: async (batch) => {
          const beforeBatch = store.counters.bytesPut;
          await appendJournalBatch(store, batch);
          journalBytesPut += store.counters.bytesPut - beforeBatch;
        },
      });
      pendingState.record(staged.staged);
      if (staged.stalePaths.length > 0) {
        if (kind === 'quiesce') await sweepOrphanBlobs(store);
        pendingState.invalidate();
        return await recordCheckpointFailure(
          ports,
          previous,
          `${String(staged.stalePaths.length)} path(s) changed while their checkpoint `
            + `chunks were read: ${staged.stalePaths.slice(0, 3).join(', ')}`,
        );
      }
      // Captured HERE, before the fold: the fold's tree, manifest and cursor
      // PUTs are the fold's own traffic, not bytes this staging moved.
      const movedBytes = store.counters.bytesPut - countersBefore.bytesPut - journalBytesPut;

      // THE STALE BYSTANDER RULE. stageBlobs stops at the first stale file —
      // everything after it in the order was scanned but NEVER journalled.
      // Persisting those fresh signatures (the old code did) told the next scan
      // the change was already committed, and it was silently lost on recycle.
      // So: keep the PREVIOUS signature for every un-journalled path — the next
      // scan re-detects and re-journals it; take the SCANNED signature only for
      // paths whose entries reached staged.staged. A tombstone drops its row:
      // the path no longer exists to be detected.
      const stagedPaths = new Set(staged.staged.map(entry => entry.path));
      const tombstonedPaths = new Set(
        staged.staged.filter(entry => entry.kind === 'delete').map(entry => entry.path),
      );
      const nextSignatures = new Map<string, UpperSignature>();
      for (const [path, signature] of Object.entries(previous?.signatures ?? {})) {
        if (!tombstonedPaths.has(path)) nextSignatures.set(path, signature);
      }
      for (const path of stagedPaths) {
        const signature = scanned.get(path);
        if (signature !== undefined) nextSignatures.set(path, signature);
      }

      if (kind === 'quiesce') {
        const folded = await foldJournalIntoTree(store);
        // `folded` names what the fold actually consumed. Stamp folded:true on
        // exactly those rows — never on an un-journalled carried row, which the
        // lower does NOT yet serve — and drop the row a folded tombstone removed.
        for (const [path, entry] of folded.foldedPaths) {
          if (entry.kind === 'delete') {
            nextSignatures.delete(path);
            continue;
          }
          const signature = nextSignatures.get(path);
          if (signature !== undefined) nextSignatures.set(path, { ...signature, folded: true });
        }
        // The off-hot-path sweep, exactly as the Lean model states it: list the
        // prefix, delete what neither the manifest nor a pending entry reaches.
        pendingState.folded();
        const swept = await sweepOrphanBlobs(store);
        ports.log(
          `${DEVBOX_WORKDIR} quiesce folded ${folded.foldedEntries} entries `
          + `(${folded.treeWrites} writes, ${folded.treeDeletes} deletes); swept `
          + `${swept.deleted} orphan blobs of ${swept.listed} listed`,
        );
      }

      await ports.writeState({
        lastCheckpointAt: ports.now(),
        signatures: Object.fromEntries(capSignatures(nextSignatures)),
        lastFailure: undefined,
      });

      const held = await ports.inventory();
      if (staged.staged.length === 0 && kind === 'tick') {
        return { kind: 'skipped', reason: 'work directory is unchanged', bytes: undefined, movedBytes: 0 };
      }
      // THE ORACLE IS WHAT THIS CHECKPOINT WROTE, not what inventory() counts.
      // inventory() answers about the container's view; a checkpoint's job is
      // to say whether the STORE now holds the change. Reading `objects === 0`
      // as "nothing was committed" reported completed work as skipped, and in
      // verdict2 that is what let a box stop believing a marker was never
      // written: `skipped 0B /workspace holds no objects yet` was returned
      // AFTER the blob, the journal batch, the fold and the cursor had all
      // landed.
      //
      // movedBytes IS THE STORE COUNTERS' bytesPut delta with the journal
      // objects subtracted back out — what this checkpoint moved as BLOBS. The
      // staged entries' file sizes were the old figure, and content-hash dedup
      // makes them lie: a pure rename stages a whole file's size while moving
      // zero bytes, which is the property the header advertises and the figure
      // must show.
      ports.log(
        `${DEVBOX_WORKDIR} ${kind} checkpoint committed (overlay-cas, `
        + `${staged.staged.length} entries, ${movedBytes}B moved into blobs; `
        + `store view ${held.objects} objects ${held.bytes}B)`,
      );
      return { kind: 'committed', reason: undefined, bytes: held.bytes, movedBytes };
    } catch (error) {
      pendingState.invalidate();
      return await recordCheckpointFailure(ports, previous, describe({ cause: error }));
    }
  };

  const detach = async (): Promise<void> => {
    if (!ports.containerRunning()) return;
    if (isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
      await ports.exec(`fusermount3 -u ${shellPath(DEVBOX_WORKDIR)} || true`);
    }
    const line = findMount(await shell.readMounts(), CAS_TREE_MOUNT);
    if (line !== undefined) await ports.unmountTree();
  };

  const discard = async (): Promise<void> => {
    pendingState.invalidate();
    await detach();
    const deleted = await ports.clearPrefix();
    await ports.clearState();
    ports.log(`${DEVBOX_WORKDIR} discarded (overlay-cas, ${deleted} objects deleted)`);
  };

  return { attach, checkpoint, detach, discard };
}

export {
  advanceCursor,
  foldJournalIntoTree,
  replayPending,
  stageBlobs,
} from './cas';
export {
  OVERLAY_CAS_STATE_MAX_BYTES,
  SIGNATURE_ROWS_MAX,
  capSignatures,
  normalizeOverlayCasState,
  overlayCasStateBytes,
  type OverlayCasState,
  type UpperSignature,
} from './cas/state';
