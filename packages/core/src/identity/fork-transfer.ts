/**
 * Workspace fork — the wire.
 *
 * A fork crosses a process boundary. On Cloudflare the source and the target
 * are two Durable Objects with no cross-DO SQL, and one serialized RPC argument
 * is capped at 32 MiB (`do.facet.rpc_bytes`) while a workspace's history is
 * not. So the snapshot is never one value on either side of the boundary.
 *
 * It crosses as SEMANTIC frames: a `begin` that declares what is coming, a
 * bounded batch of rows of one section, a bounded range of one inherited file,
 * and a `commit`. The source reads each batch out of its own SQL and forgets
 * it; the target stages each batch straight into its own SQL and forgets it.
 * Neither side ever holds the whole snapshot, and no total size is refused —
 * a bigger workspace is more frames.
 *
 * What the target stages is invisible until `commit`. Before it there is no
 * lineage, no fork marker, no mission, no display name, and the roster row is
 * still `create_pending` in the UserDO, so no user route can reach it. `commit`
 * validates the protocol version, the declared per-section counts, the frame
 * order and the rolling digest, and only then publishes.
 *
 * The frames of one fork arrive on SEVERAL activations of the target object: a
 * Durable Object's isolate can be reset between two of them while the source
 * keeps sending. So the cursor this protocol runs on — next frame, rolling
 * digest, what has been staged, whether it published — is the target's own
 * `ForkStagingState` row rather than an instance field, and an interrupted
 * transfer resumes at the frame it stopped at.
 *
 * This module owns the WIRE. The rows it carries belong to
 * `identity/fork-rows.ts`, the reads it streams them through to
 * `identity/fork-plan.ts` and the write it drives to `identity/fork-writer.ts`,
 * which together are the single authority for what a fork copies.
 */

import * as v from 'valibot';
import { createHash } from 'node:crypto';
import { SHELL_APPROVAL_AUTHORITY_KEYS } from '../config/store';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import type { SqlExecutor, VFS } from '../types/primitives';
import type { ActorHandle } from './actor-handle';
import type { VfsNativeReads } from '../vfs/mounts';
import type { ForkFileSink } from './fork-sink';
import { renderIssues } from '../utils/json';
import { openWorkspaceMainActor } from './workspace-actors';
import { forkFilePaths, type ForkFilePath } from './fork';
import {
  forkArtifactPath,
  forkConversationCounts,
  forkConversationEntryPartRows,
  forkConversationEntryRow,
  forkMessagePartRows,
  forkMessageUpdateRows,
  forkSessionMessageRow,
  planForkConversation,
  type ForkConversationPlan,
} from './fork-plan';
import {
  ForkSnapshotHeadSchema,
  ForkSessionMessageRowSchema,
  ForkMessagePartRowSchema,
  ForkMessageUpdateRowSchema,
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
  type ForkMessagePartRow,
  type ForkMessageUpdateRow,
  type ForkSessionMessageRow,
} from './fork-rows';
import { ForkTargetWriter, type ForkResult } from './fork-writer';
import type { ForkStaging, ForkStagingState } from './fork-staging';

/**
 * The fork transfer protocol this tree speaks.
 *
 * A receiver refuses a version it does not implement rather than misread the
 * frames of a deployment whose snapshot shape is not its own. Bump it when the
 * frame union changes in a way an older receiver would misinterpret.
 *
 * Version 2 carries the canonical conversation store — message identities,
 * parts, updates, public entries and the restored context membership — where
 * version 1 carried a flattened chain and its pane twin.
 */
export const FORK_TRANSFER_VERSION = 2;

/**
 * Bytes of payload one frame may carry.
 *
 * A quarter of `do.facet.rpc_bytes`, the catalogued ceiling on ONE serialized
 * RPC argument — a frame IS that argument, and the other three quarters are
 * headroom for the clone metadata and the envelope around the payload.
 *
 * This bounds a FRAME, and through the frame it bounds what either side holds
 * at once. Nothing bounds a snapshot.
 */
export const FORK_FRAME_BYTES = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;

/**
 * The row sections, in the order they must cross.
 *
 * The order is load-bearing, not cosmetic: it is the FOREIGN-KEY order of the
 * canonical store. Message identities precede their parts, parts precede the
 * updates that reference them, public entries precede their part references,
 * and the context membership lands last — so every staged statement commits
 * against rows the target already has. A hosted transfer stages one frame per
 * RPC, so there is no transaction spanning the sections to defer a constraint
 * inside.
 */
export const FORK_ROW_SECTIONS = [
  'agentConfig',
  'craftedTools',
  'memoryChunks',
  'sessionMessages',
  'messageParts',
  'messageUpdates',
  'conversationEntries',
  'conversationEntryParts',
  'contextMembers',
] as const;

export type ForkRowSection = (typeof FORK_ROW_SECTIONS)[number];

/** How many rows each section carries, and how many files follow. Declared up
 *  front by the source, checked against what arrived at `commit` — the
 *  completeness proof a lost frame cannot slip past. */
export const ForkSectionCountsSchema = v.object({
  agentConfig: v.number(),
  craftedTools: v.number(),
  memoryChunks: v.number(),
  sessionMessages: v.number(),
  messageParts: v.number(),
  messageUpdates: v.number(),
  conversationEntries: v.number(),
  conversationEntryParts: v.number(),
  contextMembers: v.number(),
  files: v.number(),
});

/** Fields every frame carries. `seq` is the frame's 0-based position; `begin`
 *  is always 0 and `commit`'s own `seq` IS the number of frames before it, so
 *  the stream length needs no separate declaration. */
const FRAME_ENVELOPE = {
  version: v.literal(FORK_TRANSFER_VERSION),
  transferId: v.string(),
  seq: v.number(),
  /** SHA-256 of this frame's own canonical preimage — the bounded per-frame
   *  check, so a corrupt frame is refused where it arrived. */
  digest: v.string(),
} as const;

/**
 * One frame of one fork transfer.
 *
 * This union is the canonical wire authority. Every TypeScript type on either
 * side of the boundary is inferred from it, so there is no second declaration
 * of the wire shape to drift, and nothing decodes a frame by assertion.
 */
export const ForkFrameSchema = v.variant('kind', [
  /** Opens the transfer: what this fork is, and what is coming. */
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
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('messageParts'), rows: v.array(ForkMessagePartRowSchema) }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('messageUpdates'), rows: v.array(ForkMessageUpdateRowSchema) }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('conversationEntries'), rows: v.array(ForkConversationEntryRowSchema) }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('conversationEntryParts'), rows: v.array(ForkConversationEntryPartRowSchema) }),
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('contextMembers'), rows: v.array(ForkContextMemberRowSchema) }),
  /**
   * One byte range of one inherited file.
   *
   * Bytes, not characters: the range boundary has to be exact to bound the RPC
   * argument, and a UTF-8 byte count is the only exact unit. `offset` is
   * checked against what the target has actually staged, never trusted.
   */
  v.object({
    ...FRAME_ENVELOPE,
    kind: v.literal('file'),
    path: v.string(),
    offset: v.number(),
    bytes: v.instance(Uint8Array),
    /** Last range of THIS file. The file is written, and counted, here. */
    last: v.boolean(),
    /** SHA-256 of the whole file's bytes, carried on `last` so the target can
     *  refuse a file that reassembled wrong before it writes it. */
    fileDigest: v.optional(v.string()),
    /** A carried PAYLOAD file, whose `path` is relative to the artifact
     *  directory that owns it. The receiver re-roots it under its own, because
     *  an absolute payload path names the plane it came from. */
    artifact: v.boolean(),
  }),
  /**
   * Closes the transfer.
   *
   * `stream` is the rolling hash over every PRECEDING frame's own `digest`, in
   * order, so a dropped, reordered or substituted frame cannot reach a matching
   * commit. It is a field of its own rather than the envelope's `digest`
   * because the envelope's digest seals each frame's own content: redeclaring
   * it here would leave the rolling value with no way onto the wire, and the
   * commit's `digest` then seals `stream` along with everything else.
   */
  v.object({ ...FRAME_ENVELOPE, kind: v.literal('commit'), stream: v.string() }),
]);

export type ForkFrame = v.InferOutput<typeof ForkFrameSchema>;

export type ForkBeginFrame = Extract<ForkFrame, { kind: 'begin' }>;

export type ForkFileFrame = Extract<ForkFrame, { kind: 'file' }>;

export type ForkRowFrame = Extract<ForkFrame, { kind: ForkRowSection }>;

export type ForkSectionCounts = v.InferOutput<typeof ForkSectionCountsSchema>;

/** A frame before it is sealed. Distributive, so the `kind` discriminant still
 *  narrows each member rather than collapsing the union. */
export type UnsealedForkFrame = ForkFrame extends infer F
  ? F extends { kind: string } ? Omit<F, 'digest'> : never
  : never;

/**
 * The canonical preimage of one frame: everything it carries except its own
 * digest, serialized deterministically.
 *
 * A file frame's bytes are hashed as bytes rather than folded into the JSON, so
 * a range never crosses a wider alphabet on its way into the hash either.
 */
type ForkFrameSealInput = UnsealedForkFrame & { digest?: string };

export function forkFramePreimage(frame: ForkFrameSealInput): string {
  if (frame.kind === 'file') {
    const { bytes, digest: _digest, ...meta } = frame;

    return `${stableStringify({ ...meta })}|${sha256Hex(bytes)}`;
  }

  const { digest: _digest, ...body } = frame;

  return stableStringify(body);
}

/** Seal a frame with its own digest. The one place a frame becomes sendable, and
 *  the one place the wire schema is applied on the way out. */
export function sealForkFrame(frame: ForkFrameSealInput): ForkFrame {
  const { digest: _discarded, ...body } = frame;

  return v.parse(ForkFrameSchema, { ...body, digest: sha256Hex(forkFramePreimage(body)) });
}

/**
 * The rolling stream digest, and its seed.
 *
 * A FOLD rather than one hash over every frame digest concatenated. The receiver
 * is a Durable Object whose activation can end between two frames, so the
 * rolling value has to be something it can STORE and resume from: a hash
 * object's internal state is not storable, and the concatenation itself grows
 * with every frame of an unbounded fork. One 64-character string is neither.
 *
 * Both halves fold the same way, so the sender can seal a commit before the
 * receiver has seen a frame of the stream and the two values still meet.
 */
export const FORK_STREAM_SEED = '';

export function foldForkStream(previous: string, digest: string): string {
  return sha256Hex(`${previous}${digest}`);
}

/**
 * The source file plane a streamed fork reads.
 *
 * The ordinary walk plus ONE extra capability: the ranged read
 * ({@link VfsNativeReads.readRange}) every Nimbus-backed plane serves natively.
 * It is required rather than optional because a plane without it can only be
 * read whole, and a fork that read one file whole would put that file's size
 * back into the isolate the framing exists to bound.
 */
export type ForkFileSource = VFS & Pick<VfsNativeReads, 'readRange'>;

/** Inputs the source half needs to read one workspace into fork frames. */
export interface ForkTransferSource {
  sql: SqlExecutor;
  /** Whose conversation is being forked. Entries, messages and memberships are
   *  keyed on the owner, so a snapshot taken without one would carry a
   *  sibling's transcript. */
  actor: ActorHandle;
  vfs: ForkFileSource;
  untilMessageId: string;
  /** Where this actor's payload files live. Carried references are made
   *  relative to it, and the payload files are streamed out of it. */
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

function sessionMessagePayloadBytes(row: ForkSessionMessageRow): number {
  return utf8Bytes(row.message_id) + utf8Bytes(row.role)
    + utf8Bytes(row.native_content_kind) + utf8Bytes(row.origin);
}

function messagePartPayloadBytes(row: ForkMessagePartRow): number {
  return utf8Bytes(row.message_id) + utf8Bytes(row.kind)
    + (row.reply_to_message_id === null ? 0 : utf8Bytes(row.reply_to_message_id));
}

/** An update's payload is the one unbounded field a conversation carries: an
 *  inline `payload_json` is a whole part's content. */
function messageUpdatePayloadBytes(row: ForkMessageUpdateRow): number {
  return utf8Bytes(row.message_id) + utf8Bytes(row.operation)
    + (row.payload_json === null ? 0 : utf8Bytes(row.payload_json))
    + (row.payload_path === null ? 0 : utf8Bytes(row.payload_path))
    + (row.payload_digest === null ? 0 : utf8Bytes(row.payload_digest));
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

/**
 * The conversation sections, read one unit at a time.
 *
 * One message's parts or one entry's part references at a time, never a
 * section: what bounds a frame is the batching below, and what bounds the
 * SENDER is reading no more than one unit of one section into the isolate.
 */
async function* sessionMessageRows(
  sql: SqlExecutor, actorId: string, plan: ForkConversationPlan,
): AsyncGenerator<ForkSessionMessageRow> {
  for (const message of plan.messages) yield forkSessionMessageRow(sql, actorId, message.messageId);
}

async function* messagePartRows(
  sql: SqlExecutor, actorId: string, plan: ForkConversationPlan,
): AsyncGenerator<ForkMessagePartRow> {
  for (const message of plan.messages) yield* forkMessagePartRows(sql, actorId, message.messageId);
}

async function* messageUpdateRows(
  sql: SqlExecutor, actorId: string, plan: ForkConversationPlan, artifactDirectory: string,
): AsyncGenerator<ForkMessageUpdateRow> {
  for (const message of plan.messages) yield* forkMessageUpdateRows(sql, actorId, message, artifactDirectory);
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

/**
 * Reads one source workspace into sealed, bounded fork frames.
 *
 * Counts and paths describe the source as it existed during the preflight reads.
 * SQLite/VFS mutation after that has no transfer snapshot isolation: a changed
 * later row or file can make the stream disagree with `begin.counts`, which the
 * receiver refuses at commit rather than silently publishing a mixed fork.
 */
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

  const filePaths: ForkFilePath[] = [];

  for await (const file of forkFilePaths(source.vfs, plan.artifacts)) filePaths.push(file);

  const conversation = forkConversationCounts(source.sql, actorId, plan);

  const counts: ForkSectionCounts = {
    agentConfig: source.sql<{ key: string }>`SELECT key FROM actor_config WHERE actor_id = ${actorId}`
      .filter((row) => !SHELL_APPROVAL_AUTHORITY_KEYS.includes(row.key)).length,
    craftedTools: source.sql<{ count: number }>`SELECT COUNT(*) AS count FROM crafted_tools`[0]?.count ?? 0,
    memoryChunks: source.sql<{ count: number }>`SELECT COUNT(*) AS count FROM memory_chunks`[0]?.count ?? 0,
    ...conversation,
    files: filePaths.length,
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

  const seal = (body: ForkFrameBody): ForkFrame => {
    const frame = sealForkFrame(body);
    stream = foldForkStream(stream, frame.digest);

    return frame;
  };

  yield seal({
    version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
    kind: 'begin', head, counts,
  });


  const yieldRows = async function* <T>(
    rows: AsyncIterable<T>,
    payloadBytes: (row: T) => number,
    frame: (rows: T[]) => ForkFrame,
  ): AsyncGenerator<ForkFrame> {
    let batch: T[] = [];
    let bytes = 0;

    for await (const row of rows) {
      const rowBytes = payloadBytes(row);

      // A single row can exceed the frame budget. Send it alone: rejecting it
      // would recreate the total-size failure framing exists to remove.
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
        yield* yieldRows(configRows(source.sql), configPayloadBytes, (rows) => seal({
          version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
          kind: 'agentConfig', rows,
        }));
        break;
      case 'craftedTools':
        yield* yieldRows(craftedToolRows(source.sql), craftedToolPayloadBytes, (rows) => seal({
          version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
          kind: 'craftedTools', rows,
        }));
        break;
      case 'memoryChunks':
        yield* yieldRows(memoryChunkRows(source.sql), memoryChunkPayloadBytes, (rows) => seal({
          version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
          kind: 'memoryChunks', rows,
        }));
        break;
      case 'sessionMessages':
        yield* yieldRows(sessionMessageRows(source.sql, actorId, plan), sessionMessagePayloadBytes, (rows) => seal({
          version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
          kind: 'sessionMessages', rows,
        }));
        break;
      case 'messageParts':
        yield* yieldRows(messagePartRows(source.sql, actorId, plan), messagePartPayloadBytes, (rows) => seal({
          version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
          kind: 'messageParts', rows,
        }));
        break;
      case 'messageUpdates':
        yield* yieldRows(
          messageUpdateRows(source.sql, actorId, plan, source.artifactDirectory),
          messageUpdatePayloadBytes,
          (rows) => seal({
            version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
            kind: 'messageUpdates', rows,
          }),
        );
        break;
      case 'conversationEntries':
        yield* yieldRows(
          conversationEntryRows(source.sql, actorId, plan, source.artifactDirectory),
          conversationEntryPayloadBytes,
          (rows) => seal({
            version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
            kind: 'conversationEntries', rows,
          }),
        );
        break;
      case 'conversationEntryParts':
        yield* yieldRows(
          conversationEntryPartRows(source.sql, actorId, plan),
          conversationEntryPartPayloadBytes,
          (rows) => seal({
            version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
            kind: 'conversationEntryParts', rows,
          }),
        );
        break;
      case 'contextMembers':
        yield* yieldRows(contextMemberRows(plan), contextMemberPayloadBytes, (rows) => seal({
          version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
          kind: 'contextMembers', rows,
        }));
        break;
    }
  }

  for (const file of filePaths) {
    // A payload file's carried path is relative to the artifact directory that
    // owns it; the read is against the SOURCE's.
    const path = file.artifact ? forkArtifactPath(file.path, source.artifactDirectory) : file.path;
    const stat = await source.vfs.stat(path);

    if (stat === null) {
      throw new Error(`fork transfer lost file ${JSON.stringify(path)} between the walk and the read`);
    }

    // Hashed as the ranges are read, so the whole-file digest the receiver
    // checks costs one range of state here rather than the file.
    const fileHash = createHash('sha256');

    for (let offset = 0; offset < stat.size || (offset === 0 && stat.size === 0); offset += source.frameBytes) {
      const length = Math.min(source.frameBytes, stat.size - offset);
      const read = length === 0 ? new Uint8Array(0) : await source.vfs.readRange(path, offset, length);

      if (read.byteLength !== length) {
        throw new Error(
          `fork transfer read ${read.byteLength} bytes of ${JSON.stringify(path)} where ${length} were asked for; `
          + 'the file changed under the transfer',
        );
      }

      // The frame owns its bytes. A plane is free to answer a range with a view
      // over a larger buffer, and structured clone carries the whole backing
      // buffer of a view — which would put more than this range on the wire.
      const range = read.slice();
      fileHash.update(range);
      const last = offset + length >= stat.size;

      if (last) {
        yield seal({
          version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
          kind: 'file', path: file.path, offset, bytes: range, last: true,
          fileDigest: fileHash.digest('hex'), artifact: file.artifact,
        });
      } else {
        yield seal({
          version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
          kind: 'file', path: file.path, offset, bytes: range, last: false, artifact: file.artifact,
        });
      }
    }
  }

  // `seal` folded each frame in as it went, so the value carried here is O(1)
  // state on BOTH halves — see {@link foldForkStream}.
  yield sealForkFrame({
    version: FORK_TRANSFER_VERSION, transferId: source.transferId, seq: seq++,
    kind: 'commit', stream,
  });
}



/** What accepting one frame did. */
export type ForkFrameOutcome =
  /** Staged. More frames are expected. */
  | { status: 'staged' }
  /** The transfer completed and the target is now a fork. */
  | { status: 'published'; result: ForkResult }
  /** A frame arrived for a transfer this receiver already published — a
   *  re-delivery after a lost reply, answered with the fork that landed. */
  | { status: 'settled'; result: ForkResult };

/**
 * Receiver-side driver for one fork transfer.
 *
 * Validates each frame against {@link ForkFrameSchema} — the wire's own
 * authority, so nothing here decodes by assertion — and stages it straight into
 * the target's storage through a {@link ForkTargetWriter}. It holds NO copy of
 * the snapshot, and no copy of the transfer either: which frame is next, the
 * section cursor, the rolling digest and the file in flight are columns of the
 * target's own {@link ForkStagingState} row, because the frames of one fork
 * arrive on SEVERAL activations of one Durable Object.
 *
 * NOTHING about the transfer lives only in the activation. Even a file whose
 * ranges are still arriving is resumable: its offset is a column, its staging is
 * adopted by the next activation's sink, and its whole-file digest is read back
 * out of that staging at the last range rather than folded in memory. The only
 * per-activation value is which path this activation has already opened on the
 * sink, so it opens it once.
 *
 * A `begin` frame resets everything and clears the target's staged rows and
 * files, which is what makes a retry self-heal and what a concurrent transfer
 * does to the one before it. Every other frame must belong to the staged
 * transfer and be the next one in order: a gap, a reordering, a foreign transfer
 * id or a corrupt frame is REFUSED, and the source is expected to destroy the
 * target rather than repair it. Nothing is published until `commit` has matched
 * the declared per-section counts and the rolling digest, so a refused transfer
 * leaves a workspace that is not a fork.
 */
export class ForkTransferReceiver {
  /** The path this activation has opened on the sink. Not the transfer's state —
   *  the sink's, and only so it is opened once per activation. */
  private opened: string | null = null;
  private readonly staging: ForkStagingState;

  constructor(
    private readonly writer: ForkTargetWriter,
    private readonly files: ForkFileSink,
  ) {
    // The write half owns the row; the wire half owns its own columns of it. One
    // accessor, so there is one statement of where the state lives.
    this.staging = writer.staging;
  }

  /** The receiver retains no file bytes. The current frame belongs to the RPC
   * caller; each range is forwarded to the sink before this method resolves. */
  get stagingBytes(): number {
    return 0;
  }

  /**
   * One frame, or a refusal.
   *
   * EVERY refusal removes the sibling temp of the file in flight — a corrupt
   * frame, a foreign transfer id and a gap are all reasons this transfer will
   * not continue, and a temp nobody will ever commit must not outlive it. The
   * destination the temp shadows is untouched either way.
   */
  async accept(wire: ForkFrame): Promise<ForkFrameOutcome> {
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

  private async acceptFrame(wire: ForkFrame): Promise<ForkFrameOutcome> {
    const frame = parseForkFrame(wire);

    if (frame.kind === 'begin') {
      await this.abortOpenFile();
      await this.writer.clearStagedFiles();
      // The write's reset comes FIRST: it replaces the whole staged row, so the
      // wire's cursor is declared onto a row that already belongs to this fork.
      this.writer.begin(frame.head);
      this.staging.declare({
        transferId: frame.transferId,
        declared: frame.counts,
        expectedSeq: 1,
        stream: foldForkStream(FORK_STREAM_SEED, frame.digest),
      });
      // Rows arrive frame by frame from here, so what an abandoned attempt left
      // has to be gone NOW rather than at publication.
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
      // The transfer already landed; a re-delivered frame must answer with the
      // fork rather than refuse one that is already correct.
      return { status: 'settled', result: landed };
    }

    if (frame.seq !== staged.expectedSeq) {
      throw new Error(
        `fork transfer frame ${frame.seq} arrived where frame ${staged.expectedSeq} was expected`,
      );
    }

    // The commit's own digest is NOT folded in: the sender computes `stream`
    // before it can seal the commit, so the rolling value covers exactly the
    // frames before it on both sides.
    if (frame.kind === 'commit') {
      return { status: 'published', result: await this.commit(staged, frame.stream) };
    }

    const sectionCursor = frame.kind === 'file'
      ? await this.stageRange(staged, frame)
      : this.stageRows(staged, frame);

    this.staging.advance({
      expectedSeq: frame.seq + 1,
      sectionCursor,
      stream: foldForkStream(staged.stream, frame.digest),
    });

    return { status: 'staged' };
  }

  /** One batch of one section, in the order the wire declares. A section that
   *  the cursor has already passed cannot come back, which is what lets each
   *  staged statement reference rows an earlier section already landed. */
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
    else if (frame.kind === 'messageParts') this.writer.stageMessageParts(frame.rows);
    else if (frame.kind === 'messageUpdates') this.writer.stageMessageUpdates(frame.rows);
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
   * One byte range of one file.
   *
   * `offset` is checked against the bytes the target has DURABLY counted, so a
   * range that arrives on a fresh activation is measured against what actually
   * landed rather than against a counter this isolate happens to hold. The first
   * range this activation sees opens the sink on those same counted bytes, which
   * is how a file interrupted part-way through continues instead of restarting.
   *
   * The count is stored AFTER the sink took the range, so an activation that
   * ends in between leaves the range re-deliverable: the source resends it at
   * the same offset and the sink overwrites the same bytes.
   *
   * A completed file is verified against the digest the source declared — read
   * back out of the staging, because no single activation need have seen every
   * range — and only then published atomically.
   */
  private async stageRange(staged: ForkStaging, frame: ForkFileFrame): Promise<number> {
    // A payload frame names its path relative to the artifact directory that
    // owned it. Everything below — the sink, the staged-file list and the
    // resumption checks — works in the TARGET's own paths, so the re-rooting
    // happens once, here.
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
    const committed = await this.files.commitFile(path);
    this.writer.stageCommittedFile(path, committed?.mission);
    this.opened = null;
    this.staging.file(null, 0);

    return FORK_ROW_SECTIONS.length;
  }

  /**
   * The completeness check, then the publication.
   *
   * Two independent proofs have to hold. The declared per-section counts must
   * equal what the target actually took, which is what a dropped batch fails.
   * And the rolling digest over every frame's own digest must match, which is
   * what a substituted or reordered batch fails even when the counts agree.
   */
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
      ['messageParts', staged.declared.messageParts, taken.messageParts],
      ['messageUpdates', staged.declared.messageUpdates, taken.messageUpdates],
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

/** Apply the wire schema to one frame, naming the transfer in any failure so an
 * operator is not left reading a bare valibot issue path. */
function parseForkFrame(frame: ForkFrame): ForkFrame {
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
