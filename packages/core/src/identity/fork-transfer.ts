/**
 * Workspace fork wire. One RPC argument is capped at 32 MiB (`do.facet.rpc_bytes`), so a fork crosses as
 * bounded frames; nothing is visible on the target until `commit`.
 */

import * as v from 'valibot';
import { createHash } from 'node:crypto';
import { SHELL_APPROVAL_AUTHORITY_KEYS } from '../config/store';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from './actor-handle';
import type { ForkFileSink } from './fork-sink';
import { renderIssues } from '../utils/json';
import { openWorkspaceMainActor } from './workspace-actors';
import {
  snapshotForkFiles, type ForkFileEntry, type ForkSnapshot, type ForkTreeEntry, type ForkTreeReader,
} from './fork';
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
import { ForkTargetWriter, type ForkResult } from './fork-writer';
import type { ForkStaging, ForkStagingState } from './fork-staging';

/** Fork transfer protocol version; a receiver refuses one it does not implement. Bump when an older
 *  receiver would misread the frame union. */
export const FORK_TRANSFER_VERSION = 3;

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

/** Per-section row counts and tree entries, declared by the source and checked at `commit`. */
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

const ForkWireEntrySchema = v.variant('kind', [
  v.object({ kind: v.literal('file'), path: ForkTreePathSchema, mode: v.number(), mtimeMs: v.number(), bytes: v.instance(Uint8Array) }),
  v.object({ kind: v.literal('directory'), path: ForkTreePathSchema, mode: v.number(), mtimeMs: v.number() }),
  v.object({ kind: v.literal('symlink'), path: ForkTreePathSchema, target: v.string() }),
]);

export type ForkWireEntry = v.InferOutput<typeof ForkWireEntrySchema>;

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
  /** One byte range of SOUL.md, a payload, or a file too large for `entries`. Bytes, since only a byte
   *  count bounds the RPC argument exactly. */
  v.object({
    ...FRAME_ENVELOPE,
    kind: v.literal('file'),
    path: ForkTreePathSchema,
    offset: v.number(),
    bytes: v.instance(Uint8Array),
    last: v.boolean(),
    /** SHA-256 of the whole file, so the target refuses a mis-reassembled file before writing it. */
    fileDigest: v.optional(v.string()),
    /** A payload file, `path` relative to its artifact directory; the receiver re-roots it. */
    artifact: v.boolean(),
    mode: v.number(),
    mtimeMs: v.number(),
  }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('entries'), entries: v.array(ForkWireEntrySchema) }),
  /** Closes the transfer. `stream` is the rolling hash over every preceding frame's `digest`, so a
     *  dropped, reordered or substituted frame cannot reach a matching commit. */
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('commit'), stream: v.string() }),
]);

export type ForkFrame = v.InferOutput<typeof ForkFrameSchema>;

export type ForkBeginFrame = Extract<ForkFrame, { kind: 'begin' }>;

export type ForkFileFrame = Extract<ForkFrame, { kind: 'file' }>;

export type ForkEntriesFrame = Extract<ForkFrame, { kind: 'entries' }>;

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

/** Canonical preimage of one frame (all but its digest); file bytes are hashed as bytes, not JSON. */
type ForkFrameSealInput = (UnsealedForkFrame | UnsealedForkSectionFrame) & { digest?: string };

function forkFramePreimage(frame: ForkFrameSealInput): string {
  if (frame.kind === 'file') {
    const { bytes, digest: _digest, ...meta } = frame;

    return `${stableStringify({ ...meta })}|${sha256Hex(bytes)}`;
  }

  if (frame.kind === 'entries') {
    const { entries, digest: _digest, ...meta } = frame;
    const hashed = entries.map((entry) => entry.kind === 'file' ? { ...entry, bytes: sha256Hex(entry.bytes) } : entry);

    return stableStringify({ ...meta, entries: hashed });
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

/** Opened once per transfer. */
export interface ForkFileSource {
  open(): Promise<ForkTreeReader>;
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
  return utf8Bytes(row.name) + utf8Bytes(row.description)
    + (row.params === null ? 0 : utf8Bytes(row.params))
    + utf8Bytes(row.code) + utf8Bytes(row.scope);
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
  return utf8Bytes(row.id) + (row.parent_id === null ? 0 : utf8Bytes(row.parent_id))
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

function wireEntryPayloadBytes(entry: ForkWireEntry): number {
  if (entry.kind === 'file') return utf8Bytes(entry.path) + entry.bytes.byteLength;

  return utf8Bytes(entry.path) + (entry.kind === 'symlink' ? utf8Bytes(entry.target) : 0);
}

function wireEntry(snapshot: ForkSnapshot, entry: ForkTreeEntry): ForkWireEntry {
  if (entry.kind === 'directory') return { kind: 'directory', path: entry.path, mode: entry.mode, mtimeMs: entry.mtimeMs };

  if (entry.kind === 'symlink') return { kind: 'symlink', path: entry.path, target: entry.target };
  // Copy: structured clone of a view carries its whole backing buffer.
  const bytes = entry.size === 0 ? new Uint8Array(0) : snapshot.read(entry, 0, entry.size).slice();

  return { kind: 'file', path: entry.path, mode: entry.mode, mtimeMs: entry.mtimeMs, bytes };
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
      SELECT rowid, name, description, params, code, scope, created_at, updated_at
      FROM crafted_tools WHERE rowid > ${rowid} ORDER BY rowid ASC LIMIT 1
    `[0];

    if (row === undefined) return;
    rowid = row.rowid;
    yield {
      name: row.name, description: row.description, params: row.params, code: row.code,
      scope: row.scope, created_at: row.created_at, updated_at: row.updated_at,
    };
  }
}

async function* memoryChunkRows(sql: SqlExecutor): AsyncGenerator<ForkMemoryChunkRow> {
  let rowid = 0;

  for (;;) {
    const row = sql<ForkMemoryChunkRow & { rowid: number }>`
      SELECT rowid, id, path, start_line, end_line, hash, text, updated_at
      FROM memory_chunks WHERE rowid > ${rowid} ORDER BY rowid ASC LIMIT 1
    `[0];

    if (row === undefined) return;
    rowid = row.rowid;
    yield {
      id: row.id, path: row.path, start_line: row.start_line, end_line: row.end_line,
      hash: row.hash, text: row.text, updated_at: row.updated_at,
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

/** Reads one source workspace into sealed, bounded fork frames. Rows have no snapshot isolation: later
 *  mutation makes the stream disagree with `begin.counts`, which the receiver refuses at commit. */
export async function* forkTransferFrames(
  source: ForkTransferSource,
): AsyncGenerator<ForkFrame> {
  if (!Number.isFinite(source.frameBytes) || source.frameBytes <= 0) {
    throw new RangeError('fork frameBytes must be a positive finite number');
  }

  const actorId = openWorkspaceMainActor(source.sql).actorId;

  const plan = planForkConversation({
    sql: source.sql, actorId, untilMessageId: source.untilMessageId,
    artifactDirectory: source.artifactDirectory,
  });

  const snapshot = snapshotForkFiles(await source.vfs.open(), plan.artifacts.map((relative) => ({
    relative, path: forkArtifactPath(relative, source.artifactDirectory),
  })));

  const conversation = forkConversationCounts(source.sql, actorId, plan);

  const counts: ForkSectionCounts = {
    agentConfig: source.sql<{ key: string }>`SELECT key FROM actor_config WHERE actor_id = ${actorId}`
      .filter((row) => !SHELL_APPROVAL_AUTHORITY_KEYS.includes(row.key)).length,
    craftedTools: source.sql<{ count: number }>`SELECT COUNT(*) AS count FROM crafted_tools`[0]?.count ?? 0,
    memoryChunks: source.sql<{ count: number }>`SELECT COUNT(*) AS count FROM memory_chunks`[0]?.count ?? 0,
    ...conversation,
    files: snapshot.entries.length,
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

  const seal = (body: ForkFrameBody | UnsealedForkSectionFrame): ForkFrame => {
    const frame = sealForkFrame(body);
    stream = foldForkStream(stream, frame.digest);

    return frame;
  };

  yield seal({
    version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
    kind: 'begin', head, counts,
  });

  const yieldRows = async function* <T extends ForkRowValue>(
    kind: ForkRowSection,
    rows: AsyncIterable<T>,
    payloadBytes: (row: T) => number,
  ): AsyncGenerator<ForkFrame> {
    const frame = (batched: T[]): ForkFrame => seal({
      version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
      kind, rows: batched,
    });

    let batch: T[] = [];
    let bytes = 0;

    for await (const row of rows) {
      const rowBytes = payloadBytes(row);

      // A single row may exceed the frame budget; send it alone rather than reject it.
      if (batch.length > 0 && bytes + rowBytes > source.frameBytes) {
        yield frame(batch);
        batch = [];
        bytes = 0;
      }

      batch.push(row);
      bytes += rowBytes;
    }

    if (batch.length > 0) yield frame(batch);
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

  const fileFrames = function* (file: ForkFileEntry): Generator<ForkFrame> {
    // Hashed as ranges are read, so the whole-file digest costs one range of state.
    const fileHash = createHash('sha256');

    for (let offset = 0; offset < file.size || (offset === 0 && file.size === 0); offset += source.frameBytes) {
      const length = Math.min(source.frameBytes, file.size - offset);
      // Copy: structured clone of a view carries its whole backing buffer.
      const range = length === 0 ? new Uint8Array(0) : snapshot.read(file, offset, length).slice();

      fileHash.update(range);
      const last = offset + length >= file.size;

      const frame = {
        version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
        kind: 'file', path: file.path, offset, bytes: range, artifact: file.artifact, mode: file.mode, mtimeMs: file.mtimeMs,
      } as const;

      yield seal(last ? { ...frame, last: true, fileDigest: fileHash.digest('hex') } : { ...frame, last: false });
    }
  };

  let batch: ForkWireEntry[] = [];
  let batchBytes = 0;

  const entriesFrame = (): ForkFrame => {
    const frame = seal({ version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++, kind: 'entries', entries: batch });
    batch = [];
    batchBytes = 0;

    return frame;
  };

  for (const entry of snapshot.entries) {
    // SOUL.md's protected write and a payload's re-rooting need their own frames.
    if (entry.kind === 'file' && (entry.artifact || entry.path === SOUL_PATH || entry.size > source.frameBytes)) {
      if (batch.length > 0) yield entriesFrame();
      yield* fileFrames(entry);
      continue;
    }

    const wire = wireEntry(snapshot, entry);
    const bytes = wireEntryPayloadBytes(wire);

    if (batch.length > 0 && batchBytes + bytes > source.frameBytes) yield entriesFrame();
    batch.push(wire);
    batchBytes += bytes;
  }

  if (batch.length > 0) yield entriesFrame();

  // O(1) on both halves; see {@link foldForkStream}.
  yield sealForkFrame({
    version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
    kind: 'commit', stream,
  });
}

export type ForkFrameOutcome =
  | { status: 'staged' }
  /** The transfer completed and the target is now a fork. */
  | { status: 'published'; result: ForkResult }
  /** A re-delivered frame for an already-published transfer, answered with the fork that landed. */
  | { status: 'settled'; result: ForkResult };

/**
 * Receiver-side driver for one fork transfer. All transfer state lives in the target's
 * {@link ForkStagingState} row, since frames arrive on several DO activations; a mid-file range resumes.
 * `begin` resets and clears staging; any gap, reorder, foreign id or corrupt frame is refused.
 */
export class ForkTransferReceiver {
  /** Path this activation has opened on the sink, so it is opened once per activation. */
  private opened: string | null = null;
  private readonly staging: ForkStagingState;

  constructor(
    private readonly writer: ForkTargetWriter,
    private readonly files: ForkFileSink,
  ) {
    this.staging = writer.staging;
  }

  /** The receiver retains no file bytes; each range reaches the sink before this method resolves. */
  get stagingBytes(): number {
    return 0;
  }

  /** One frame, or a refusal. Every refusal removes the in-flight file's sibling temp. */
  async accept(wire: ForkFrameWire): Promise<ForkFrameOutcome> {
    try {
      return await this.acceptFrame(wire);
    } catch (cause) {
      try {
        await this.abortOpenFile();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          'fork transfer refused a frame and could not remove the staged temp it left behind',
          { cause },
        );
      }

      throw cause;
    }
  }

  private async acceptFrame(wire: ForkFrameWire): Promise<ForkFrameOutcome> {
    const frame = parseForkFrame(wire);

    if (frame.kind === 'begin') {
      await this.abortOpenFile();
      await this.files.remove(this.staging.files());
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
      throw new Error(`fork transfer frame ${frame.seq} has no open transfer to continue`);
    }

    if (frame.transferId !== staged.transferId) {
      throw new Error(
        `fork transfer frame ${frame.seq} belongs to transfer ${frame.transferId}, `
        + `and ${staged.transferId} is the transfer open here`,
      );
    }

    const landed = this.writer.published;

    if (landed !== null) {
      // Already landed: answer a re-delivered frame with the fork.
      return { status: 'settled', result: landed };
    }

    if (frame.seq !== staged.expectedSeq) {
      throw new Error(
        `fork transfer frame ${frame.seq} arrived where frame ${staged.expectedSeq} was expected`,
      );
    }

    // The commit's own digest is not folded in: the sender computes `stream` before sealing the commit.
    if (frame.kind === 'commit') {
      return { status: 'published', result: await this.commit(staged, frame.stream) };
    }

    const sectionCursor = await this.stage(staged, frame);

    this.staging.advance({
      expectedSeq: frame.seq + 1,
      sectionCursor,
      stream: foldForkStream(staged.stream, frame.digest),
    });

    return { status: 'staged' };
  }

  private async stage(staged: ForkStaging, frame: Exclude<ForkFrame, { kind: 'begin' | 'commit' }>): Promise<number> {
    if (frame.kind === 'file') return this.stageRange(staged, frame);

    if (frame.kind === 'entries') return this.stageEntries(staged, frame);

    return this.stageRows(staged, frame);
  }

  /** One batch of one section; a section the cursor has passed cannot come back. */
  private stageRows(staged: ForkStaging, frame: ForkRowFrame): number {
    const at = FORK_ROW_SECTIONS.indexOf(frame.kind);

    if (at < staged.sectionCursor) {
      throw new Error(
        `fork transfer sent section ${frame.kind} after section `
        + `${FORK_ROW_SECTIONS[staged.sectionCursor] ?? 'files'}, out of the order the protocol fixes`,
      );
    }

    if (frame.kind === 'agentConfig') this.writer.stageAgentConfig(frame.rows);
    else if (frame.kind === 'craftedTools') this.writer.stageCraftedTools(frame.rows);
    else if (frame.kind === 'memoryChunks') this.writer.stageMemoryChunks(frame.rows);
    else if (frame.kind === 'sessionMessages') this.writer.stageSessionMessages(frame.rows);
    else if (frame.kind === 'conversationEntries') this.writer.stageConversationEntries(frame.rows);
    else if (frame.kind === 'conversationEntryParts') this.writer.stageConversationEntryParts(frame.rows);
    else this.writer.stageContextMembers(frame.rows);

    return at;
  }

  private async abortOpenFile(): Promise<void> {
    const path = this.opened;

    if (path === null) return;
    this.opened = null;
    this.staging.file(null, 0);
    await this.files.abortFile(path);
  }

  /**
     * One byte range of one file. `offset` is checked against durably counted bytes; the count is stored after
     * the sink takes the range so it stays re-deliverable. A completed file is verified from staging, then published.
     */
  private async stageRange(staged: ForkStaging, frame: ForkFileFrame): Promise<number> {
    // Re-root a payload path into the target's own paths once, here.
    const path = frame.artifact ? this.writer.artifactPath(frame.path) : frame.path;

    if (staged.filePath !== null && staged.filePath !== path) {
      throw new Error(`fork transfer began file ${JSON.stringify(path)} while ${JSON.stringify(staged.filePath)} was still incomplete`);
    }

    if (frame.offset !== staged.fileBytes) {
      throw new Error(`fork transfer range for ${JSON.stringify(path)} declares offset ${frame.offset} where ${staged.fileBytes} bytes have arrived`);
    }

    if (this.opened !== path) {
      await this.files.beginFile(path, staged.filePath === path ? staged.fileBytes : 0);
      this.opened = path;

      if (staged.filePath === null) this.staging.file(path, 0);
    }

    await this.files.writeRange(path, frame.offset, frame.bytes, frame.last);
    const arrived = staged.fileBytes + frame.bytes.byteLength;

    if (!frame.last) {
      this.staging.file(path, arrived);

      return FORK_ROW_SECTIONS.length;
    }

    const digest = await this.files.stagedDigest(path, arrived);

    if (frame.fileDigest !== digest) throw new Error(`fork transfer file ${JSON.stringify(path)} does not match the digest the source declared`);
    const committed = await this.files.commitFile(path, { mode: frame.mode, mtimeMs: frame.mtimeMs });
    this.writer.stageCommittedFile(path, committed?.mission);
    this.opened = null;
    this.staging.file(null, 0);

    return FORK_ROW_SECTIONS.length;
  }

  private async stageEntries(staged: ForkStaging, frame: ForkEntriesFrame): Promise<number> {
    if (staged.filePath !== null) {
      throw new Error(`fork transfer sent whole entries while ${JSON.stringify(staged.filePath)} was still incomplete`);
    }

    await this.files.place(frame.entries);
    this.writer.stageCommittedEntries(frame.entries.map((entry) => entry.path));

    return FORK_ROW_SECTIONS.length;
  }

  /** Completeness then publication: declared counts must match what was taken, and the rolling digest must match. */
  private async commit(staged: ForkStaging, declared: string): Promise<ForkResult> {
    if (staged.filePath !== null) {
      throw new Error(`fork transfer committed while file ${JSON.stringify(staged.filePath)} was incomplete`);
    }

    const taken = this.writer.staged;

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
        throw new Error(
          `fork transfer declared ${want} ${section} and staged ${got}; refusing to publish an incomplete fork`,
        );
      }
    }

    if (staged.stream !== declared) {
      throw new Error(
        'fork transfer digest does not match the sequence of frames that arrived; '
        + 'refusing to publish a fork assembled from a different stream',
      );
    }

    return this.writer.publish();
  }
}

/** Apply the wire schema to one frame, naming the transfer in any failure. */
function parseForkFrame(frame: ForkFrameWire): ForkFrame {
  const parsed = v.safeParse(ForkFrameSchema, frame);

  if (!parsed.success) {
    throw new Error(`fork transfer frame is not valid for protocol version ${FORK_TRANSFER_VERSION}: `
      + renderIssues(parsed.issues));
  }

  const { digest, ...body } = parsed.output;

  if (digest !== sha256Hex(forkFramePreimage(body))) {
    throw new Error(`fork transfer frame ${parsed.output.seq} digest does not match its content`);
  }

  return parsed.output;
}
