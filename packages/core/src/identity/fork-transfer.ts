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
import { SHELL_APPROVAL_AUTHORITY_KEYS } from '../config/store';
import { KinuError } from '../obs/error';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import type { SqlExecutor } from '../types/primitives';
import { WORKSPACE_ROOT } from '../vfs/workspace-path';
import type { ActorHandle } from './actor-handle';
import type { ForkFileSink } from './fork-sink';
import { renderIssues, type JsonObject } from '../utils/json';
import { compareCodeUnits } from '../utils/text';
import { openWorkspaceMainActor } from './workspace-actors';
import { FORK_PIN_PREFIX, forkCarries, type ForkFileSource, type ForkPinnedFiles } from './fork';
import { SOUL_PATH } from './soul';
import {
  forkArtifactPath,
  forkConversationCounts,
  forkConversationEntryPartRows,
  forkConversationEntryRow,
  forkSessionMessageRow,
  planForkConversation,
  type ForkConversationPlan,
} from './fork-plan';
import {
  ForkSnapshotHeadSchema,
  ForkSessionMessageRowSchema,
  ForkConversationEntryRowSchema,
  ForkConversationEntryPartRowSchema,
  ForkContextMemberRowSchema,
  ForkMemoryChunkRowSchema,
  ForkCraftedToolRowSchema,
  ForkConfigRowSchema,
  type ForkConfigRow,
  type ForkContextMemberRow,
  type ForkConversationEntryPartRow,
  type ForkConversationEntryRow,
  type ForkCraftedToolRow,
  type ForkMemoryChunkRow,
  type ForkSessionMessageRow,
} from './fork-rows';
import { ForkTargetWriter, forkResultOf, type ForkResult } from './fork-writer';
import type { ForkStaging, ForkStagingState } from './fork-staging';

/** Fork transfer protocol version; a receiver refuses one it does not implement. Bump when an older
 *  receiver would misread the frame union. v4 carries files as Nimbus export pages and chunks. */
export const FORK_TRANSFER_VERSION = 4;

/** Payload bytes per frame: a quarter of `do.facet.rpc_bytes`, leaving headroom for clone metadata and envelope. */
export const FORK_FRAME_BYTES = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;

/** Row sections in crossing order, which is the canonical store's foreign-key order (no transaction spans frames). */
export const FORK_ROW_SECTIONS = [
  'agentConfig',
  'craftedTools',
  'memoryChunks',
  'sessionMessages',
  'conversationEntries',
  'conversationEntryParts',
  'contextMembers',
] as const;

export type ForkRowSection = (typeof FORK_ROW_SECTIONS)[number];

/** Per-section row counts, and the files (SOUL.md and each import), declared by the source and checked at `commit`. */
const ForkSectionCountsSchema = v.object({
  agentConfig: v.number(),
  craftedTools: v.number(),
  memoryChunks: v.number(),
  sessionMessages: v.number(),
  conversationEntries: v.number(),
  conversationEntryParts: v.number(),
  contextMembers: v.number(),
  files: v.number(),
});

/** Fields every frame carries. `seq` is 0-based; `commit`'s `seq` is the number of frames before it. */
const FRAME_ENVELOPE = {
  version: v.literal(FORK_TRANSFER_VERSION),
  transferId: v.string(),
  seq: v.number(),
  /** SHA-256 of this frame's canonical preimage, so a corrupt frame is refused on arrival. */
  digest: v.string(),
} as const;

/** Relative, no empty, `.` or `..` segment: no frame names a path outside the tree. */
const ForkTreePathSchema = v.pipe(
  v.string(),
  v.check((path) => !path.startsWith('/') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'a fork path is relative and has no empty, "." or ".." segment'),
);

/** A name directly under the home: one segment. */
const ForkHomeNameSchema = v.pipe(
  v.string(),
  v.check((name) => name !== '' && name !== '.' && name !== '..' && !name.includes('/'), 'a home name is one path segment'),
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
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('agentConfig'), rows: v.array(ForkConfigRowSchema) }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('craftedTools'), rows: v.array(ForkCraftedToolRowSchema) }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('memoryChunks'), rows: v.array(ForkMemoryChunkRowSchema) }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('sessionMessages'), rows: v.array(ForkSessionMessageRowSchema) }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('conversationEntries'), rows: v.array(ForkConversationEntryRowSchema) }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('conversationEntryParts'), rows: v.array(ForkConversationEntryPartRowSchema) }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('contextMembers'), rows: v.array(ForkContextMemberRowSchema) }),
  /** SOUL.md whole: its protected write takes one argument. */
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('soul'), bytes: v.instance(Uint8Array) }),
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

export type ForkSectionCounts = v.InferOutput<typeof ForkSectionCountsSchema>;

/** A frame before it is sealed; distributive so `kind` still narrows each member. */
export type UnsealedForkFrame = ForkFrame extends infer F
  ? F extends { kind: string } ? Omit<F, 'digest'> : never
  : never;

export type ForkRowValue = ForkRowFrame['rows'][number];

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
 * Canonical preimage of one frame (all but its digest). SOUL.md's bytes are hashed as bytes, not JSON; a chunk is
 * named by the sha256 of its bytes, which the target's import re-hashes before storing it.
 */
type ForkFrameSealInput = (UnsealedForkFrame | UnsealedForkSectionFrame) & { digest?: string };

function forkFramePreimage(frame: ForkFrameSealInput): string {
  if (frame.kind === 'soul') {
    const { bytes, digest: _digest, ...meta } = frame;

    return `${stableStringify({ ...meta })}|${sha256Hex(bytes)}`;
  }

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
  transferId: string;
  /** Max payload bytes per frame. Production passes FORK_FRAME_BYTES. */
  frameBytes: number;
}

type ForkFrameBody = UnsealedForkFrame;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

function configPayloadBytes(row: ForkConfigRow): number {
  return utf8Bytes(row.key) + utf8Bytes(row.value);
}

function craftedToolPayloadBytes(row: ForkCraftedToolRow): number {
  return utf8Bytes(row.name) + utf8Bytes(row.description) + utf8Bytes(row.code);
}

function memoryChunkPayloadBytes(row: ForkMemoryChunkRow): number {
  return utf8Bytes(row.id) + utf8Bytes(row.path) + utf8Bytes(row.hash) + utf8Bytes(row.text);
}

/** Message content is the one unbounded conversation field: inline `content_json` is a whole message's parts. */
function sessionMessagePayloadBytes(row: ForkSessionMessageRow): number {
  return utf8Bytes(row.message_id) + utf8Bytes(row.role)
    + utf8Bytes(row.native_content_kind) + utf8Bytes(row.origin) + utf8Bytes(row.envelope_json)
    + (row.content_json === null ? 0 : utf8Bytes(row.content_json))
    + (row.content_path === null ? 0 : utf8Bytes(row.content_path))
    + (row.content_digest === null ? 0 : utf8Bytes(row.content_digest));
}

function conversationEntryPayloadBytes(row: ForkConversationEntryRow): number {
  return utf8Bytes(row.id)
    + utf8Bytes(row.role)
    + (row.turn_id === null ? 0 : utf8Bytes(row.turn_id))
    + (row.run_id === null ? 0 : utf8Bytes(row.run_id))
    + (row.metadata_json === null ? 0 : utf8Bytes(row.metadata_json))
    + (row.metadata_path === null ? 0 : utf8Bytes(row.metadata_path))
    + (row.metadata_digest === null ? 0 : utf8Bytes(row.metadata_digest));
}

function conversationEntryPartPayloadBytes(row: ForkConversationEntryPartRow): number {
  return utf8Bytes(row.entry_id) + utf8Bytes(row.message_id);
}

function contextMemberPayloadBytes(row: ForkContextMemberRow): number {
  return utf8Bytes(row.entry_id) + utf8Bytes(row.message_id);
}

async function* configRows(sql: SqlExecutor): AsyncGenerator<ForkConfigRow> {
  const actor = openWorkspaceMainActor(sql);
  let rowid = 0;

  for (;;) {
    const row = sql<ForkConfigRow & { rowid: number }>`
      SELECT rowid, key, value FROM actor_config
      WHERE actor_id = ${actor.actorId} AND rowid > ${rowid}
      ORDER BY rowid ASC LIMIT 1
    `[0];

    if (row === undefined) return;
    rowid = row.rowid;

    if (SHELL_APPROVAL_AUTHORITY_KEYS.includes(row.key)) continue;
    yield { key: row.key, value: row.value };
  }
}

async function* craftedToolRows(sql: SqlExecutor): AsyncGenerator<ForkCraftedToolRow> {
  let rowid = 0;

  for (;;) {
    const row = sql<ForkCraftedToolRow & { rowid: number }>`
      SELECT rowid, name, description, code, created_at, updated_at
      FROM crafted_tools WHERE rowid > ${rowid} ORDER BY rowid ASC LIMIT 1
    `[0];

    if (row === undefined) return;
    rowid = row.rowid;
    yield {
      name: row.name, description: row.description, code: row.code,
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }
}

async function* memoryChunkRows(sql: SqlExecutor): AsyncGenerator<ForkMemoryChunkRow> {
  let rowid = 0;

  for (;;) {
    const row = sql<ForkMemoryChunkRow & { rowid: number }>`
      SELECT rowid, id, path, start_line, end_line, hash, text
      FROM memory_chunks WHERE rowid > ${rowid} ORDER BY rowid ASC LIMIT 1
    `[0];

    if (row === undefined) return;
    rowid = row.rowid;
    yield {
      id: row.id, path: row.path, start_line: row.start_line, end_line: row.end_line,
      hash: row.hash, text: row.text,
    };
  }
}

/** Conversation sections, read one message or one entry's parts at a time to bound the sender. */
async function* sessionMessageRows(
  sql: SqlExecutor, actorId: string, plan: ForkConversationPlan, artifactDirectory: string,
): AsyncGenerator<ForkSessionMessageRow> {
  for (const messageId of plan.messageIds) yield forkSessionMessageRow(sql, actorId, messageId, artifactDirectory);
}

async function* conversationEntryRows(
  sql: SqlExecutor, actorId: string, plan: ForkConversationPlan, artifactDirectory: string,
): AsyncGenerator<ForkConversationEntryRow> {
  for (const entryId of plan.entryIds) yield forkConversationEntryRow(sql, actorId, entryId, artifactDirectory);
}

async function* conversationEntryPartRows(
  sql: SqlExecutor, actorId: string, plan: ForkConversationPlan,
): AsyncGenerator<ForkConversationEntryPartRow> {
  for (const entryId of plan.entryIds) yield* forkConversationEntryPartRows(sql, actorId, entryId);
}

async function* contextMemberRows(plan: ForkConversationPlan): AsyncGenerator<ForkContextMemberRow> {
  for (const member of plan.members) yield member;
}

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
    const soulPath = `${WORKSPACE_ROOT}/${SOUL_PATH}`;
    const soul = pinned.kind(soulPath) === 'file' ? pinned.readFile(soulPath) : null;

    if (soul !== null && soul.byteLength > source.frameBytes) {
      throw new KinuError('bad_input', `SOUL.md is ${soul.byteLength} bytes, past the ${source.frameBytes} one fork frame carries; `
        + 'its protected write takes the file whole');
    }

    const imports: ForkImport[] = [
      ...pinned.readdir(WORKSPACE_ROOT).filter(forkCarries).sort(compareCodeUnits)
        .map((name): ForkImport => ({ target: { in: 'home', name }, root: `${WORKSPACE_ROOT}/${name}` })),
      ...carriedPayloads(pinned, plan.artifacts, source.artifactDirectory),
    ];

    const conversation = forkConversationCounts(source.sql, actorId, plan);

    const counts: ForkSectionCounts = {
      agentConfig: source.sql<{ key: string }>`SELECT key FROM actor_config WHERE actor_id = ${actorId}`
        .filter((row) => !SHELL_APPROVAL_AUTHORITY_KEYS.includes(row.key)).length,
      craftedTools: source.sql<{ count: number }>`SELECT COUNT(*) AS count FROM crafted_tools`[0]?.count ?? 0,
      memoryChunks: source.sql<{ count: number }>`SELECT COUNT(*) AS count FROM memory_chunks`[0]?.count ?? 0,
      ...conversation,
      files: imports.length + (soul === null ? 0 : 1),
    };

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

    const yieldRows = async function* <T extends ForkRowValue>(
      kind: ForkRowSection,
      rows: AsyncIterable<T>,
      payloadBytes: (row: T) => number,
    ): AsyncGenerator<ForkFrame, void, ForkFrameReply | undefined> {
      let batch: T[] = [];
      let bytes = 0;

      for await (const row of rows) {
        const rowBytes = payloadBytes(row);

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

    for (const section of FORK_ROW_SECTIONS) {
      switch (section) {
        case 'agentConfig':
          yield* yieldRows(section, configRows(source.sql), configPayloadBytes);
          break;
        case 'craftedTools':
          yield* yieldRows(section, craftedToolRows(source.sql), craftedToolPayloadBytes);
          break;
        case 'memoryChunks':
          yield* yieldRows(section, memoryChunkRows(source.sql), memoryChunkPayloadBytes);
          break;
        case 'sessionMessages':
          yield* yieldRows(
            section,
            sessionMessageRows(source.sql, actorId, plan, source.artifactDirectory),
            sessionMessagePayloadBytes,
          );
          break;
        case 'conversationEntries':
          yield* yieldRows(
            section,
            conversationEntryRows(source.sql, actorId, plan, source.artifactDirectory),
            conversationEntryPayloadBytes,
          );
          break;
        case 'conversationEntryParts':
          yield* yieldRows(section, conversationEntryPartRows(source.sql, actorId, plan), conversationEntryPartPayloadBytes);
          break;
        case 'contextMembers':
          yield* yieldRows(section, contextMemberRows(plan), contextMemberPayloadBytes);
          break;
      }
    }

    // Copy: structured clone of a view carries its whole backing buffer.
    if (soul !== null) yield* send({ ...envelope(), kind: 'soul', bytes: soul.slice() });

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
      if (frame.kind === 'soul') {
        yield* this.filesPhase(staged);
        this.writer.stageSoul((yield* Effect.promise(() => this.files.publishSoul(frame.bytes))).mission);

        return { status: 'staged', sectionCursor: FORK_ROW_SECTIONS.length };
      }

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

    if (frame.kind === 'agentConfig') this.writer.stageAgentConfig(frame.rows);
    else if (frame.kind === 'craftedTools') this.writer.stageCraftedTools(frame.rows);
    else if (frame.kind === 'memoryChunks') this.writer.stageMemoryChunks(frame.rows);
    else if (frame.kind === 'sessionMessages') this.writer.stageSessionMessages(frame.rows);
    else if (frame.kind === 'conversationEntries') this.writer.stageConversationEntries(frame.rows);
    else if (frame.kind === 'conversationEntryParts') this.writer.stageConversationEntryParts(frame.rows);
    else this.writer.stageContextMembers(frame.rows);

    return Effect.succeed(at);
  }

  /** Files come once the row sections are done, and one import at a time. */
  private filesPhase(staged: ForkStaging): Effect.Effect<void> {
    return staged.importing === null
      ? Effect.void
      : Effect.die(new Error(`fork transfer sent SOUL.md while the import at ${JSON.stringify(staged.importing)} was still incomplete`));
  }

  /**
   * The destination of one import frame, re-rooted into the target's own paths once, here. An import's first frame
   * opens it, replacing what the target was born with there (its own `.nimbusrc`, say: the fork carries the
   * source's), and records it, so `begin` removes it if this transfer is abandoned; no other may start until it is
   * done. Replacing before recording keeps a frame re-delivered in between from replacing a started import.
   */
  private open(staged: ForkStaging, target: ForkImportTarget): Effect.Effect<string> {
    return Effect.gen({ self: this }, function* () {
      // SOUL.md publishes only through its protected write; the rest are the target's own to make.
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

      const taken = staged.staged;

      const shortfall = [
        ['agentConfig', staged.declared.agentConfig, taken.agentConfig],
        ['craftedTools', staged.declared.craftedTools, taken.craftedTools],
        ['memoryChunks', staged.declared.memoryChunks, taken.memoryChunks],
        ['sessionMessages', staged.declared.sessionMessages, taken.sessionMessages],
        ['conversationEntries', staged.declared.conversationEntries, taken.conversationEntries],
        ['conversationEntryParts', staged.declared.conversationEntryParts, taken.conversationEntryParts],
        ['contextMembers', staged.declared.contextMembers, taken.contextMembers],
        ['files', staged.declared.files, taken.files],
      ] as const;

      for (const [section, want, got] of shortfall) {
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
