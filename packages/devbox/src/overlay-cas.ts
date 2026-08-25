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
 * ── THE VERDICT, DEPLOYED, 2026-08-25 ───────────────────────────────────────
 *
 * NOT THE DEFAULT. `snapshot-chain` is. This strategy is RETAINED as a
 * selectable one, and the honest reason is narrow: on the measured corpus it
 * wins nothing.
 *
 * The O(pending) claim HELD in deployment — and so did the incumbent's. Same
 * corpus, same segment, bytes moved per tick:
 *
 *     240 KiB edit      chain 4,096 B | r2fs 4,096 B | overlay-cas 4,096 B
 *     ~9.8 MiB commits  chain 8.78 MiB           | overlay-cas 8.73 MiB
 *     ~6.4 MiB rewrite  chain 2.30 MiB           | overlay-cas 2.30 MiB
 *
 * A 240 KiB edit costs one block here, which is the property this design was
 * built for. The chain reaches the same number to the byte, so wall time came
 * out at ~1.29x against a 10x bar. There is no asymptotic gap to find, not
 * because this arm fails to be O(p) but because the thing it was meant to
 * improve on is already O(p) once its rebase cadence keeps c near p.
 *
 * WHERE IT IS STILL THE RIGHT CHOICE, and this is UNMEASURED — recorded as a
 * hypothesis, not a result: the long-lived box, where rebase cadence CANNOT
 * hold c near p. The chain's attach pays the cumulative changed-set since its
 * base; this one pays the pending set since the last fold, and a fold is
 * cheap and frequent. That difference only appears in a regime this corpus
 * never entered, so nobody should cite these numbers as evidence for it.
 *
 * An earlier reading of the bench reported a 2,351x write amplification here.
 * It was an artifact of differencing a CUMULATIVE held-bytes field as though
 * it were per-tick, retracted by the instrument's owner. Recorded because the
 * retraction is the reason this file was not rewritten to chase a defect that
 * did not exist.
 */

import * as v from 'valibot';

import { describeThrown as describe, findMount } from './lifecycle';
import { isOverlayMounted, shouldCheckpoint } from './snapshot-chain';
import {
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStorage,
  type StoredValue,
  recordCheckpointFailure,
} from './storage';
import {
  CHUNK_SIZE,
  appendJournalBatch,
  foldJournalIntoTree,
  readFoldedSeq,
  replayPending,
  seqFromJournalKey,
  stageBlobs,
  stampEntries,
  vanishedTombstones,
  type CasStore,
  type FileDigest,
  type JournalEntry,
  type NewJournalEntry,
} from './cas';

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

export interface UpperSignature {
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly mode: number;
  readonly mtimeMs: number;
  readonly mtimeNs?: string;
  readonly size: number;
  readonly hash?: string;
  readonly target?: string;
  readonly folded?: boolean;
}

export interface OverlayCasState {
  readonly lastCheckpointAt: number;
  readonly signatures: { readonly [path: string]: UpperSignature };
  readonly knownBlobs: readonly string[];
  readonly lastFailure: { readonly at: number; readonly reason: string } | undefined;
}

/**
 * The stored record, as a schema.
 *
 * A durable row is untrusted input: it was written by some release of this
 * package, and the reader has to establish what it is rather than assume. A row
 * this code did not write reads as ABSENT, which makes a fresh box whose first
 * checkpoint rebuilds the signatures from the upper, rather than as a state
 * whose signatures cannot be trusted, which would make a box that either
 * refuses forever or — far worse — treats every path it cannot recognise as
 * vanished and tombstones the workspace.
 *
 * `knownBlobs` is deliberately permissive about content: losing it costs
 * operations, never correctness, because a re-PUT under a content-addressed
 * key is a no-op and an unknown hash is simply re-HEADed.
 */
const UpperSignatureSchema = v.object({
  kind: v.picklist(['file', 'dir', 'symlink']),
  mode: v.number(),
  mtimeMs: v.number(),
  mtimeNs: v.optional(v.string()),
  size: v.number(),
  hash: v.optional(v.pipe(v.string(), v.length(64))),
  target: v.optional(v.string()),
  folded: v.optional(v.boolean()),
});

const OverlayCasStateSchema = v.object({
  lastCheckpointAt: v.number(),
  signatures: v.record(v.string(), UpperSignatureSchema),
  knownBlobs: v.array(v.pipe(v.string(), v.length(64))),
  lastFailure: v.optional(v.object({ at: v.number(), reason: v.string() })),
});

export function normalizeOverlayCasState(raw: StoredValue): OverlayCasState | null {
  const parsed = v.safeParse(OverlayCasStateSchema, raw);
  if (!parsed.success) return null;
  // Written out rather than spread, so the parse produces EXACTLY the contract.
  // The schema's optional fields become present-and-undefined here, which is
  // what the record declares and what every reader checks.
  const row = parsed.output;
  const signatures: Record<string, UpperSignature> = {};
  for (const [path, signature] of Object.entries(row.signatures)) {
    signatures[path] = {
      kind: signature.kind,
      mode: signature.mode,
      mtimeMs: signature.mtimeMs,
      mtimeNs: signature.mtimeNs,
      size: signature.size,
      hash: signature.hash,
      target: signature.target,
      folded: signature.folded,
    };
  }
  return {
    lastCheckpointAt: row.lastCheckpointAt,
    signatures,
    knownBlobs: row.knownBlobs,
    lastFailure: row.lastFailure,
  };
}

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
      const stdout = await must(
        'digesting changed upper files',
        `sh ${shellPath(DIGEST_SCRIPT_PATH)} ${batch.map(shellPath).join(' ')}`,
      );
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
      const walked = await ports.exec(
        `if ! test -d ${shellPath(upperDir)}; then printf 'UPPER-GONE\\0'; exit 0; fi; `
        + `printf 'UPPER-OK\\0'; `
        + `find ${shellPath(upperDir)} -mindepth 1 `
        + `-printf '%y\\0%m\\0%s\\0%T@\\0%n\\0%l\\0%p\\0'`,
      );
      // CLASSIFICATION ORDER MATTERS: GONE is decided by its own marker, an
      // unsuccessful exit is a failed walk even when partial records came back,
      // and only a zero exit may be parsed. Checking the OK marker first would
      // let an exec-level failure lie about an upper it never saw.
      if (walked.stdout.startsWith('UPPER-GONE\0')) throw new UpperVanished(upperDir);
      if (walked.exitCode !== 0) {
        throw new Error(
          `walk of ${upperDir} failed (${walked.exitCode}) after `
          + `${parseUpperWalk(walked.stdout.replace(/^UPPER-OK\0/, '')).length} records: `
          + `${walked.stderr.trim() || walked.stdout.trim() || 'no diagnostic'}`,
        );
      }
      const records = parseUpperWalk(walked.stdout.slice('UPPER-OK\0'.length));

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
        if (record.type === 'f') files.push(record);
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
    materialize: async (entry: JournalEntry, bytes: Uint8Array | null): Promise<void> => {
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
          if (bytes === null) throw new Error(`file entry replayed without bytes: ${entry.path}`);
          await must(`preparing ${entry.path}`, `mkdir -p ${shellPath(parent)}`);
          await ports.writeFileBase64(absolute, encodeBase64(bytes));
          await must(
            `setting mode on ${entry.path}`,
            `chmod ${entry.mode.toString(8)} ${shellPath(absolute)}`,
          );
          return;
        }
        case 'symlink': {
          await must(
            `materializing symlink ${entry.path}`,
            `mkdir -p ${shellPath(parent)} && ln -sfn ${shellPath(entry.target)} `
            + shellPath(absolute),
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
  };
}

/** Parents before children, deletes last within a level, so a replay never
 *  writes into a directory it has not created. */
function byApplyOrder(a: NewJournalEntry, b: NewJournalEntry): number {
  const depth = a.path.split('/').length - b.path.split('/').length;
  if (depth !== 0) return depth;
  const rank = kindRank(a) - kindRank(b);
  if (rank !== 0) return rank;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function kindRank(entry: NewJournalEntry): number {
  switch (entry.kind) {
    case 'dir': return 0;
    case 'file': return 1;
    case 'symlink': return 2;
    default: return 3;
  }
}


export function overlayCasStorage(ports: OverlayCasPorts): DevboxStorage {
  const shell = casShell(ports);

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
      await shell.materialize(item.entry, item.bytes);
    }
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

    // The scan is INSIDE the failure boundary. It reaches the container, so it
    // can refuse — an absent upper means this is not the container that was
    // attached — and this seam's contract is that an ordinary failure travels
    // as a value. A throw here would reach a scheduled callback, which reduces
    // it to a console line and loses the incident.
    let fresh: readonly NewJournalEntry[];
    let scanned: ReadonlyMap<string, UpperSignature>;
    try {
      const scan = await shell.scanUpper(signatures);
      const tombstoned = new Set(
        scan.entries.filter(entry => entry.kind === 'delete').map(entry => entry.path),
      );
      const vanished = vanishedTombstones(signatures, new Set(scan.signatures.keys()), tombstoned);
      fresh = [...scan.entries, ...vanished];
      scanned = scan.signatures;
    } catch (error) {
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
      const store = ports.store();
      const foldedSeq = await readFoldedSeq(store);
      const pending = await store.list('journal/');
      let nextSeq = foldedSeq + 1;
      for (const key of pending) {
        const seq = seqFromJournalKey(key);
        if (seq !== null && seq + 1 > nextSeq) nextSeq = seq + 1;
      }
      const stamped = stampEntries(fresh, nextSeq);
      const known = new Set(previous?.knownBlobs ?? []);
      // Journal objects are written PER BATCH, inside commitBatch, so they land
      // only after that batch's blobs are durable. A crash therefore redoes one
      // batch rather than losing the whole change set.
      const staged = await stageBlobs({
        store,
        entries: stamped,
        readChunk: (entry, index, size) => shell.readUpperChunk(entry.path, index, size),
        known,
        commitBatch: async (batch) => {
          await appendJournalBatch(store, batch);
        },
      });
      // A stale file (bytes no longer match the digest) must not become a
      // journal object. Drop its signature so the next scan re-hashes it.
      const nextSignatures = new Map(scanned);
      for (const path of staged.stalePaths) nextSignatures.delete(path);

      if (kind === 'quiesce') {
        const folded = await foldJournalIntoTree(store);
        for (const [path, signature] of nextSignatures) {
          nextSignatures.set(path, { ...signature, folded: true });
        }
        ports.log(
          `${DEVBOX_WORKDIR} quiesce folded ${folded.foldedEntries} entries `
          + `(${folded.treeWrites} writes, ${folded.treeDeletes} deletes)`,
        );
      }

      await ports.writeState({
        lastCheckpointAt: ports.now(),
        signatures: Object.fromEntries(nextSignatures),
        knownBlobs: [...known],
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
      // landed. The bytes below come from the staging that actually happened.
      // `bytes` MEANS HELD-AFTER-COMMIT, per storage.ts. That field was
      // unified across strategies precisely because it once meant two things
      // and a caller comparing two strategies compared nothing; reporting
      // staged-this-checkpoint here would re-open that. The staged figure is
      // still computed, because it is what proves the checkpoint did work and
      // it is the honest per-tick cost a caller cannot get by differencing
      // held bytes across a fold — that derivation goes NEGATIVE at a rebase.
      const committedBytes = staged.staged.reduce(
        (sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0),
        0,
      );
      ports.log(
        `${DEVBOX_WORKDIR} ${kind} checkpoint committed (overlay-cas, `
        + `${staged.staged.length} entries, ${committedBytes}B staged this checkpoint; `
        + `store view ${held.objects} objects ${held.bytes}B)`,
      );
      return { kind: 'committed', reason: undefined, bytes: held.bytes, movedBytes: committedBytes };
    } catch (error) {
      return await recordCheckpointFailure(ports, previous, describe({ cause: error }));
    }
  };

  const discard = async (): Promise<void> => {
    if (ports.containerRunning() && isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
      await ports.exec(`fusermount3 -u ${shellPath(DEVBOX_WORKDIR)} || true`);
    }
    if (ports.containerRunning()) {
      const line = findMount(await shell.readMounts(), CAS_TREE_MOUNT);
      if (line !== undefined) await ports.unmountTree();
    }
    const deleted = await ports.clearPrefix();
    await ports.clearState();
    ports.log(`${DEVBOX_WORKDIR} discarded (overlay-cas, ${deleted} objects deleted)`);
  };

  return { attach, checkpoint, discard };
}

export {
  advanceCursor,
  foldJournalIntoTree,
  replayPending,
  stageBlobs,
} from './cas';
