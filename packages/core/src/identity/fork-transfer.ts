/**
 * Workspace fork wire. One RPC argument is capped at 32 MiB (`do.facet.rpc_bytes`), so a fork crosses as
 * bounded frames; the target is not a fork until `commit`. Files cross as Nimbus's export: pages of rows, and the
 * chunks they name that the target does not hold.
 */

import { Effect } from 'effect';
import { settle } from '../obs/effect';
import * as v from 'valibot';
import type { VfsExportChunk, VfsExportPage } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { VfsExportPageSchema } from '../vfs/export-page';
import { KinuError } from '../obs/error';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import type { SqlExecutor } from '../types/primitives';
import { isTreeRelativePath, WORKSPACE_ROOT } from '../vfs/workspace-path';
import type { ActorHandle } from './actor-handle';
import type { ForkFileSink } from './fork-sink';
import { renderIssues, type JsonObject } from '../utils/json';
import { compareCodeUnits } from '../utils/text';
import { openWorkspaceMainActor } from './workspace-actors';
import { FORK_PIN_PREFIX, forkCarries, type ForkFileSource, type ForkPinnedFiles } from './fork';
import { forkArtifactPath, planForkConversation } from './fork-plan';
import { ForkSnapshotHeadSchema } from './fork-rows';
import {
  FORK_ROW_SECTIONS, FORK_SECTIONS, forkSectionCount, perSection,
  type ForkAppData, type ForkRows, type ForkRowSection, type ForkSection, type ForkSectionSource,
} from './fork-sections';
import { ForkSectionCountsSchema, ForkTargetWriter, forkResultOf, type ForkResult, type ForkStagedCounts } from './fork-writer';
import type { ForkStaging, ForkStagingState } from './fork-staging';

/** Fork transfer protocol version; a receiver refuses one it does not implement. Bump when an older
 *  receiver would misread the frame union. v5 carries no memory index: the target derives it from the notes. v6 carries
 *  the main actor's lessons, tool lessons, facts and `db` tables. */
export const FORK_TRANSFER_VERSION = 6;

/** Payload bytes per frame: a quarter of `do.facet.rpc_bytes`, leaving headroom for clone metadata and envelope. */
export const FORK_FRAME_BYTES = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;

export { FORK_ROW_SECTIONS, type ForkAppData, type ForkRowSection } from './fork-sections';

/** Fields every frame carries. `seq` is 0-based; `commit`'s `seq` is the number of frames before it. */
const FRAME_ENVELOPE = {
  version: v.literal(FORK_TRANSFER_VERSION),
  transferId: v.string(),
  seq: v.number(),
  /** SHA-256 of this frame's canonical preimage, so a corrupt frame is refused on arrival. */
  digest: v.string(),
} as const;

/** One batch of one row section, its rows checked by the section's own schema. */
function rowFrameSchema<K extends ForkRowSection>(kind: K) {
  return v.object({ ...FRAME_ENVELOPE, kind: v.literal(kind), rows: v.array(FORK_SECTIONS[kind].rows) });
}

/** Relative, no empty, `.` or `..` segment: no frame names a path outside the tree. */
const ForkTreePathSchema = v.pipe(
  v.string(),
  v.check(isTreeRelativePath, 'a fork path is relative and has no empty, "." or ".." segment'),
);

/** A name directly under the home: one segment. */
const ForkHomeNameSchema = v.pipe(
  v.string(),
  v.check((name) => isTreeRelativePath(name) && !name.includes('/'), 'a home name is one path segment'),
);

/** Where an import lands: a tree under the home, or a payload the receiver re-roots into its own artifact directory. */
const ForkImportTargetSchema = v.variant('in', [
  v.object({ in: v.literal('home'), name: ForkHomeNameSchema }),
  v.object({ in: v.literal('artifacts'), path: ForkTreePathSchema }),
]);

export type ForkImportTarget = v.InferOutput<typeof ForkImportTargetSchema>;

const ForkExportChunkSchema: v.GenericSchema<VfsExportChunk> = v.object({ hash: v.string(), data: v.instance(Uint8Array) });

/** One frame of one fork transfer; the canonical wire authority every type on both sides is inferred from. */
const ForkFrameSchema = v.variant('kind', [
  v.object({
    ...FRAME_ENVELOPE,
    kind: v.literal('begin'),
    head: ForkSnapshotHeadSchema,
    counts: ForkSectionCountsSchema,
  }),
  // Named one by one so each frame's rows keep their own type; `rowSectionsOnTheWire` holds the list to the sections.
  rowFrameSchema('agentConfig'),
  rowFrameSchema('craftedTools'),
  rowFrameSchema('sessionMessages'),
  rowFrameSchema('conversationEntries'),
  rowFrameSchema('conversationEntryParts'),
  rowFrameSchema('contextMembers'),
  rowFrameSchema('lessons'),
  rowFrameSchema('toolLessons'),
  rowFrameSchema('facts'),
  rowFrameSchema('ownerQuestions'),
  rowFrameSchema('appTables'),
  rowFrameSchema('appRows'),
  /** Chunks a page names that the target lacked, stored ahead of that page. */
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('chunks'), target: ForkImportTargetSchema, chunks: v.array(ForkExportChunkSchema) }),
  /** One page of one import. */
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('page'), target: ForkImportTargetSchema, page: VfsExportPageSchema }),
  /** Closes the transfer. `stream` is the rolling hash over every preceding frame's `digest`, so a
     *  dropped, reordered or substituted frame cannot reach a matching commit. */
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('commit'), stream: v.string() }),
]);

export type ForkFrame = v.InferOutput<typeof ForkFrameSchema>;

export type ForkBeginFrame = Extract<ForkFrame, { kind: 'begin' }>;

export type ForkChunksFrame = Extract<ForkFrame, { kind: 'chunks' }>;

export type ForkPageFrame = Extract<ForkFrame, { kind: 'page' }>;

export type ForkRowFrame = Extract<ForkFrame, { kind: ForkRowSection }>;

// Every section has its frame on the wire.
const rowSectionsOnTheWire: Exclude<ForkRowSection, ForkRowFrame['kind']> extends never ? true : never = true;

void rowSectionsOnTheWire;

export type ForkSectionCounts = ForkStagedCounts;

/** A frame before it is sealed; distributive so `kind` still narrows each member. */
export type UnsealedForkFrame = ForkFrame extends infer F
  ? F extends { kind: string } ? Omit<F, 'digest'> : never
  : never;

type ForkRowValue = ForkRowFrame['rows'][number];

/** One frame before schema validation; the version is the sender's claim so a refused frame can be held. */
export type ForkFrameWire = ForkFrame extends infer F
  ? F extends { version: number } ? Omit<F, 'version'> & { version: number } : never
  : never;

/** One row section's frame before sealing; {@link sealForkFrame} rejects a name paired with the wrong rows. */
type UnsealedForkSectionFrame =
  Omit<Extract<UnsealedForkFrame, { kind: 'agentConfig' }>, 'kind' | 'rows'>
  & { kind: ForkRowSection; rows: ForkRowValue[] };

/** A page as JSON, every field the wire schema carries named. */
function pageJson(page: VfsExportPage): JsonObject {
  return {
    schema: page.schema,
    source: page.source,
    root: page.root,
    nextIno: page.nextIno,
    after: page.after,
    next: page.next,
    rows: page.rows.map((row) => ({
      path: row.path,
      ino: row.ino,
      kind: row.kind,
      size: row.size,
      mode: row.mode,
      uid: row.uid,
      gid: row.gid,
      defaultAcl: row.defaultAcl,
      atime: row.atime,
      mtime: row.mtime,
      contentKey: row.contentKey,
      pieceOffset: row.pieceOffset,
      manifest: row.manifest,
      pieces: row.pieces.map(([hash, size]) => [hash, size]),
    })),
  };
}

/**
 * Canonical preimage of one frame (all but its digest). A chunk is named by the sha256 of its bytes, which the
 * target's import re-hashes before storing it.
 */
type ForkFrameSealInput = (UnsealedForkFrame | UnsealedForkSectionFrame) & { digest?: string };

function forkFramePreimage(frame: ForkFrameSealInput): string {
  if (frame.kind === 'chunks') {
    const { chunks, digest: _digest, ...meta } = frame;

    return stableStringify({ ...meta, chunks: chunks.map((chunk) => chunk.hash) });
  }

  if (frame.kind === 'page') {
    const { page, digest: _digest, ...meta } = frame;

    return stableStringify({ ...meta, page: pageJson(page) });
  }

  const { digest: _digest, ...body } = frame;

  return stableStringify(body);
}

/** Seal a frame with its digest; the one place the wire schema is applied outbound. */
export function sealForkFrame(frame: ForkFrameSealInput): ForkFrame {
  const { digest: _discarded, ...body } = frame;

  return v.parse(ForkFrameSchema, { ...body, digest: sha256Hex(forkFramePreimage(body)) });
}

/** Rolling stream digest and seed. A fold, so the receiver can store and resume one 64-char value
 *  across DO activations. */
export const FORK_STREAM_SEED = '';

export function foldForkStream(previous: string, digest: string): string {
  return sha256Hex(`${previous}${digest}`);
}

export interface ForkTransferSource {
  sql: SqlExecutor;
  /** Whose conversation is forked; rows are keyed on the owner, so omitting it would carry a sibling's transcript. */
  actor: ActorHandle;
  vfs: ForkFileSource;
  untilMessageId: string;
  /** This actor's payload directory; references are made relative to it. */
  artifactDirectory: string;
  /** The `db` tool's store as that actor reads it (`AppDataStore.fork`); the fork only reads it. */
  appData: ForkAppData;
  transferId: string;
  /** Max payload bytes per frame. Production passes FORK_FRAME_BYTES. */
  frameBytes: number;
}

type ForkFrameBody = UnsealedForkFrame;

/** What the target answered the frame just yielded, passed back into the stream. */
export interface ForkFrameReply {
  /** A page the target could not import yet: the chunks it holds neither staged nor stored. */
  readonly want?: readonly string[];
}

/** One import the fork carries: where it lands, and the pinned path it is exported from. */
interface ForkImport {
  readonly target: ForkImportTarget;
  readonly root: string;
}

/** A payload the cut's conversation references, each once, refused unless it is a file at the pin. */
function carriedPayloads(pinned: ForkPinnedFiles, artifacts: readonly string[], artifactDirectory: string): ForkImport[] {
  const carried = new Map<string, ForkImport>();

  for (const relative of artifacts) {
    if (carried.has(relative)) continue;
    const root = forkArtifactPath(relative, artifactDirectory);

    if (pinned.kind(root) !== 'file') {
      throw new KinuError('missing', `fork cannot carry payload ${JSON.stringify(root)}: the conversation references it and it is not a file`);
    }

    carried.set(relative, { target: { in: 'artifacts', path: relative }, root });
  }

  return [...carried.values()];
}

/**
 * Reads one source workspace into sealed, bounded fork frames. `next(reply)` passes back what the target answered the
 * frame just yielded: a page naming chunks the target lacks comes back with them wanted, and the stream sends those
 * and the page again, so a chunk the target already holds never crosses. Rows have no snapshot isolation: later
 * mutation makes the stream disagree with `begin.counts`, which the receiver refuses at commit. Files are read from
 * one pin of the source's store, released however the stream ends.
 */
export async function* forkTransferFrames(
  source: ForkTransferSource,
): AsyncGenerator<ForkFrame, void, ForkFrameReply | undefined> {
  if (!Number.isFinite(source.frameBytes) || source.frameBytes <= 0) {
    throw new RangeError('fork frameBytes must be a positive finite number');
  }

  const actorId = openWorkspaceMainActor(source.sql).actorId;

  const plan = planForkConversation({
    sql: source.sql, actorId, untilMessageId: source.untilMessageId,
    artifactDirectory: source.artifactDirectory,
  });

  const pinned = await source.vfs.pin(`${FORK_PIN_PREFIX}${source.transferId}`);

  try {
    const imports: ForkImport[] = [
      ...pinned.readdir(WORKSPACE_ROOT).filter(forkCarries).sort(compareCodeUnits)
        .map((name): ForkImport => ({ target: { in: 'home', name }, root: `${WORKSPACE_ROOT}/${name}` })),
      ...carriedPayloads(pinned, plan.artifacts, source.artifactDirectory),
    ];

    const sections: ForkSectionSource = {
      sql: source.sql, actorId, plan, artifactDirectory: source.artifactDirectory, appData: source.appData,
    };

    const counts: ForkSectionCounts = { ...perSection((kind) => forkSectionCount(kind, sections)), files: imports.length };

    const identity = source.sql<{ id: string; name: string }>`
      SELECT id, name FROM workspace_identity LIMIT 1
    `[0];

    const head: v.InferOutput<typeof ForkSnapshotHeadSchema> = {
      source: { workspaceId: identity?.id ?? '', workspaceName: identity?.name ?? '' },
      cut: { messageId: plan.cut.entryId, createdAtMs: plan.cut.recordedAt },
    };

    let seq = 0;
    let stream = FORK_STREAM_SEED;

    const envelope = () => ({ version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq }) as const;

    /** Yields one frame; the sequence and the rolling digest advance only past a frame the target took. */
    const send = async function* (
      body: ForkFrameBody | UnsealedForkSectionFrame,
    ): AsyncGenerator<ForkFrame, ForkFrameReply | undefined, ForkFrameReply | undefined> {
      const frame = sealForkFrame(body);
      const reply = yield frame;

      if (reply?.want === undefined) {
        seq += 1;
        stream = foldForkStream(stream, frame.digest);
      }

      return reply;
    };

    yield* send({ ...envelope(), kind: 'begin', head, counts });

    const yieldRows = async function* <K extends ForkRowSection>(
      kind: K, declared: ForkSection<ForkRows[K]>,
    ): AsyncGenerator<ForkFrame, void, ForkFrameReply | undefined> {
      let batch: ForkRows[K][] = [];
      let bytes = 0;

      for (const row of declared.select(sections)) {
        const rowBytes = declared.bytes(row);

        // A single row may exceed the frame budget; send it alone rather than reject it.
        if (batch.length > 0 && bytes + rowBytes > source.frameBytes) {
          yield* send({ ...envelope(), kind, rows: batch });
          batch = [];
          bytes = 0;
        }

        batch.push(row);
        bytes += rowBytes;
      }

      if (batch.length > 0) yield* send({ ...envelope(), kind, rows: batch });
    };

    for (const kind of FORK_ROW_SECTIONS) yield* yieldRows(kind, FORK_SECTIONS[kind]);

    /** The chunks a page wants, a frame of them at a time. */
    const chunkFrames = async function* (
      target: ForkImportTarget, wanted: readonly string[],
    ): AsyncGenerator<ForkFrame, void, ForkFrameReply | undefined> {
      for (let rest = [...wanted]; rest.length > 0;) {
        const out = pinned.exportChunks(rest, source.frameBytes);
        // Copy: structured clone of a view carries its whole backing buffer.
        const chunks = out.chunks.map((chunk) => ({ hash: chunk.hash, data: chunk.data.slice() }));

        yield* send({ ...envelope(), kind: 'chunks', target, chunks });
        rest = out.rest;
      }
    };

    /**
     * One import, a page at a time, each until the target takes it. A reset on the target can collect chunks it
     * staged, so a page wants again what it lost; wanting exactly what it was just sent means it keeps none.
     */
    const importFrames = async function* ({ target, root }: ForkImport): AsyncGenerator<ForkFrame, void, ForkFrameReply | undefined> {
      for (let after: string | null = null, more = true; more;) {
        const page = pinned.exportPage(root, after);
        let wanted = (yield* send({ ...envelope(), kind: 'page', target, page }))?.want;
        let asked: string | null = null;

        while (wanted !== undefined) {
          const asking = [...wanted].sort(compareCodeUnits).join(',');

          if (asking === asked) {
            throw new Error(`the fork target wants the same ${wanted.length} chunk(s) of ${JSON.stringify(root)} it was just sent`);
          }

          asked = asking;
          yield* chunkFrames(target, wanted);
          wanted = (yield* send({ ...envelope(), kind: 'page', target, page }))?.want;
        }

        more = page.next !== null;
        after = page.next;
      }
    };

    for (const carried of imports) yield* importFrames(carried);

    // O(1) on both halves; see {@link foldForkStream}.
    yield* send({ ...envelope(), kind: 'commit', stream });
  } finally {
    await pinned.release();
  }
}

export type ForkFrameOutcome =
  | { status: 'staged' }
  /** A page naming chunks the target holds neither staged nor stored: nothing was taken, send them and it again. */
  | { status: 'want'; hashes: string[] }
  /** The transfer completed and the target is now a fork. */
  | { status: 'published'; result: ForkResult }
  /** A re-delivered frame for an already-published transfer, answered with the fork that landed. */
  | { status: 'settled'; result: ForkResult };

/**
 * Receiver-side driver for one fork transfer. All transfer state lives in the target's {@link ForkStagingState} row,
 * since frames arrive on several DO activations; an import resumes from Nimbus's own cursor. `begin` resets and
 * removes what an abandoned transfer imported; any gap, reorder, foreign id or corrupt frame is refused.
 */
export class ForkTransferReceiver {
  private readonly staging: ForkStagingState;

  constructor(
    private readonly writer: ForkTargetWriter,
    private readonly files: ForkFileSink,
  ) {
    this.staging = writer.staging;
  }

  /** One frame, or a refusal. */
  accept(wire: ForkFrameWire): Promise<ForkFrameOutcome> {
    return settle(Effect.gen({ self: this }, function* () {
      const frame = yield* parseForkFrame(wire);

      if (frame.kind === 'begin') {
        yield* Effect.promise(() => this.files.remove(this.staging.files()));
        this.staging.dropFiles();
        // The write's reset first: the wire's cursor is declared onto a row that already belongs to this fork.
        this.writer.begin(frame.head);
        this.staging.declare({
          transferId: frame.transferId,
          declared: frame.counts,
          expectedSeq: 1,
          stream: foldForkStream(FORK_STREAM_SEED, frame.digest),
        });
        // Rows arrive frame by frame from here, so an abandoned attempt's rows must go now.
        this.writer.clearStagedRows();

        return { status: 'staged' };
      }

      const staged = this.staging.read();

      if (staged === null || staged.transferId === null) {
        return yield* Effect.die(new Error(`fork transfer frame ${frame.seq} has no open transfer to continue`));
      }

      if (frame.transferId !== staged.transferId) {
        return yield* Effect.die(new Error(
          `fork transfer frame ${frame.seq} belongs to transfer ${frame.transferId}, `
          + `and ${staged.transferId} is the transfer open here`,
        ));
      }

      if (staged.published && staged.head !== null) {
        // Already landed: answer a re-delivered frame with the fork.
        return { status: 'settled', result: forkResultOf(staged.head, staged.staged) };
      }

      if (frame.seq !== staged.expectedSeq) {
        return yield* Effect.die(new Error(
          `fork transfer frame ${frame.seq} arrived where frame ${staged.expectedSeq} was expected`,
        ));
      }

      // The commit's own digest is not folded in: the sender computes `stream` before sealing the commit.
      if (frame.kind === 'commit') {
        return { status: 'published', result: yield* this.commit(staged, frame.stream) };
      }

      const taken = yield* this.stage(staged, frame);

      if (taken.status === 'want') return taken;

      this.staging.advance({
        expectedSeq: frame.seq + 1,
        sectionCursor: taken.sectionCursor,
        stream: foldForkStream(staged.stream, frame.digest),
      });

      return { status: 'staged' };
    }));
  }

  private stage(
    staged: ForkStaging, frame: Exclude<ForkFrame, { kind: 'begin' | 'commit' }>,
  ): Effect.Effect<{ status: 'staged'; sectionCursor: number } | { status: 'want'; hashes: string[] }> {
    return Effect.gen({ self: this }, function* () {
      if (frame.kind === 'chunks') {
        const dst = yield* this.open(staged, frame.target);
        yield* Effect.promise(() => this.files.importChunks(dst, frame.chunks));

        return { status: 'staged', sectionCursor: FORK_ROW_SECTIONS.length };
      }

      if (frame.kind === 'page') {
        const dst = yield* this.open(staged, frame.target);
        const imported = yield* Effect.promise(() => this.files.importPage(dst, frame.page));

        if (imported.want.length > 0) return { status: 'want', hashes: imported.want };

        if (imported.done) this.staging.importing(null);

        return { status: 'staged', sectionCursor: FORK_ROW_SECTIONS.length };
      }

      return { status: 'staged', sectionCursor: yield* this.stageRows(staged, frame) };
    });
  }

  /** One batch of one section; a section the cursor has passed cannot come back. */
  private stageRows(staged: ForkStaging, frame: ForkRowFrame): Effect.Effect<number> {
    const at = FORK_ROW_SECTIONS.indexOf(frame.kind);

    if (at < staged.sectionCursor) {
      return Effect.die(new Error(
        `fork transfer sent section ${frame.kind} after section `
        + `${FORK_ROW_SECTIONS[staged.sectionCursor] ?? 'files'}, out of the order the protocol fixes`,
      ));
    }

    this.writer.stage(frame.kind, frame.rows);

    return Effect.succeed(at);
  }

  /**
   * The destination of one import frame, re-rooted into the target's own paths once, here. An import's first frame
   * opens it, replacing what the target was born with there (its own `.nimbusrc`, say: the fork carries the
   * source's), and records it, so `begin` removes it if this transfer is abandoned; no other may start until it is
   * done. Replacing before recording keeps a frame re-delivered in between from replacing a started import.
   */
  private open(staged: ForkStaging, target: ForkImportTarget): Effect.Effect<string> {
    return Effect.gen({ self: this }, function* () {
      // The rest are the target's own to make.
      if (target.in === 'home' && !forkCarries(target.name)) {
        return yield* Effect.die(new Error(`fork transfer sent an import of ${JSON.stringify(target.name)}, a name under the home a fork does not carry`));
      }

      const dst = target.in === 'home' ? `${WORKSPACE_ROOT}/${target.name}` : this.writer.artifactPath(target.path);

      if (staged.importing === dst) return dst;

      if (staged.importing !== null) {
        return yield* Effect.die(new Error(`fork transfer began the import at ${JSON.stringify(dst)} while ${JSON.stringify(staged.importing)} was still incomplete`));
      }

      yield* Effect.promise(() => this.files.remove([dst]));
      this.staging.addFile(dst);
      this.staging.importing(dst);

      return dst;
    });
  }

  /** Completeness then publication: declared counts must match what was taken, and the rolling digest must match. */
  private commit(staged: ForkStaging, declared: string): Effect.Effect<ForkResult, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (staged.importing !== null) {
        return yield* Effect.die(new Error(`fork transfer committed while the import at ${JSON.stringify(staged.importing)} was incomplete`));
      }

      for (const section of [...FORK_ROW_SECTIONS, 'files'] as const) {
        const want = staged.declared[section];
        const got = staged.staged[section];

        if (want !== got) {
          return yield* Effect.die(new Error(
            `fork transfer declared ${want} ${section} and staged ${got}; refusing to publish an incomplete fork`,
          ));
        }
      }

      if (staged.stream !== declared) {
        return yield* Effect.die(new Error(
          'fork transfer digest does not match the sequence of frames that arrived; '
          + 'refusing to publish a fork assembled from a different stream',
        ));
      }

      return yield* Effect.promise(() => this.writer.publish());
    });
  }
}

/** Apply the wire schema to one frame, naming the transfer in any failure. */
function parseForkFrame(frame: ForkFrameWire): Effect.Effect<ForkFrame, KinuError> {
  return Effect.gen(function* () {
    const parsed = v.safeParse(ForkFrameSchema, frame);

    if (!parsed.success) {
      return yield* Effect.die(new Error(`fork transfer frame is not valid for protocol version ${FORK_TRANSFER_VERSION}: `
        + renderIssues(parsed.issues)));
    }

    const { digest, ...body } = parsed.output;

    if (digest !== sha256Hex(forkFramePreimage(body))) {
      return yield* Effect.die(new Error(`fork transfer frame ${parsed.output.seq} digest does not match its content`));
    }

    return parsed.output;
  });
}
