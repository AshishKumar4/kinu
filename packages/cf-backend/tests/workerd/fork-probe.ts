/**
 * A hosted fork across two real Durable Objects, evicted between frames: the receiver's cursor must
 * outlive an isolate reset, which bun cannot host. The probes run the production halves; only the SQL
 * bridge, file plane and (resumable) delivery driver are local.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  agentArtifactDirectory, agentHome, CHAT_SESSION_ID, MAIN_AGENT,
  FORK_STREAM_SEED, ForkStagingState, ForkTargetWriter, ForkTransferReceiver, NativeSinkPlan, SOUL_PATH,
  foldForkStream, forkTransferFrames, initWorkspaceSchema, readForkLineage, sealForkFrame,
  SessionHistory, summarizeSoulBytes, WorkspaceActorDirectory, openWorkspaceMainActor,
  type ForkFrame, type ForkLineageRow, type ForkNativeFilePort, type ForkResult,
  type ForkStaging, type SqlExecutor, type SqlValue, type VFS, type VfsEntryStat,
} from '@kinu.run/core';

/** Small on purpose: at production `FORK_FRAME_BYTES` each section fits one frame and the eviction boundaries vanish. */
const PROBE_FRAME_BYTES = 64;

export const PROBE_CUT_MESSAGE_ID = 'm3';

const PROBE_ARTIFACTS = agentArtifactDirectory(agentHome(MAIN_AGENT));

/** Fixture restamp of the cut entry: the target publishes the cut entry's stamp as the fork point. */
export const PROBE_CUT_RECORDED_AT = Date.parse('2026-01-01T00:00:03.000Z');

export const PROBE_SOURCE_NAME = 'fork-source';

const SOUL_CONTENT = '# Mission\nProve a fork survives an eviction.\n';

export const PROBE_SOUL_MISSION = summarizeSoulBytes(new TextEncoder().encode(SOUL_CONTENT));

/** workerd's streaming digest; the ambient `Crypto` type does not declare it. */
interface WorkerdDigestStream extends WritableStream<ArrayBufferView | ArrayBuffer> {
  readonly digest: Promise<ArrayBuffer>;
}

declare const crypto: Crypto & {
  DigestStream: new (algorithm: string) => WorkerdDigestStream;
};

/**
 * The probe's file plane: one durable BLOB row per written range, so no file is ever held whole.
 * Bind `bytes.slice().buffer`, not `bytes.buffer`: a payload is a view over a larger buffer.
 */
class ProbeFilePlane implements VFS {
  static readonly DDL = `CREATE TABLE IF NOT EXISTS probe_file_ranges (
    path  TEXT    NOT NULL,
    start INTEGER NOT NULL,
    bytes BLOB    NOT NULL,
    PRIMARY KEY (path, start)
  )`;

  constructor(private readonly ctx: DurableObjectState) {}

  get native(): ForkNativeFilePort {
    return {
      truncate: async (path, size) => {
        this.exec(`DELETE FROM probe_file_ranges WHERE path = ? AND start >= ?`, path, size);
        this.exec(
          `UPDATE probe_file_ranges SET bytes = substr(bytes, 1, ? - start)
             WHERE path = ? AND start < ? AND start + length(bytes) > ?`,
          size, path, size, size,
        );
      },
      writeRange: async (path, offset, bytes) => {
        this.exec(
          `INSERT OR REPLACE INTO probe_file_ranges (path, start, bytes) VALUES (?, ?, ?)`,
          path, offset, bytes.slice().buffer,
        );
      },
      readRange: (path, offset, length) => this.readRange(path, offset, length),
      rename: async (from, to) => {
        this.ctx.storage.transactionSync(() => {
          this.exec(`DELETE FROM probe_file_ranges WHERE path = ?`, to);
          this.exec(`UPDATE probe_file_ranges SET path = ? WHERE path = ?`, to, from);
        });
      },
      unlink: async (path) => { this.exec(`DELETE FROM probe_file_ranges WHERE path = ?`, path); },
    };
  }

  /** One byte range, clipped inside SQLite so a read never materializes more than the request. */
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const end = offset + length;
    const out = new Uint8Array(length);
    let filled = 0;

    for (const row of this.exec(
      `SELECT start, substr(bytes, max(1, ? - start + 1), ? - max(?, start)) AS bytes
         FROM probe_file_ranges
         WHERE path = ? AND start < ? AND start + length(bytes) > ?
         ORDER BY start`,
      offset, end, offset, path, end, offset,
    )) {
      if (!(row.bytes instanceof ArrayBuffer)) throw new Error('probe range read a non-BLOB');
      const part = new Uint8Array(row.bytes);
      out.set(part, Math.max(0, Number(row.start) - offset));
      filled += part.byteLength;
    }

    return filled === length ? out : out.subarray(0, filled);
  }

  async stat(path: string): Promise<VfsEntryStat | null> {
    const raw = this.exec(
      `SELECT max(start + length(bytes)) AS size FROM probe_file_ranges WHERE path = ?`, path,
    )[0]?.size;

    const size = raw === null || raw === undefined ? null : Number(raw);

    if (size !== null && size !== undefined) return { size, mtimeMs: 0, isDir: false };

    const holds = this.exec(
      `SELECT 1 AS found FROM probe_file_ranges WHERE path LIKE ? LIMIT 1`, `${path}/%`,
    );

    return holds.length === 0 ? null : { size: 0, mtimeMs: 0, isDir: true };
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  async readdir(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    const names = new Set<string>();

    for (const row of this.exec(
      `SELECT DISTINCT path FROM probe_file_ranges WHERE path LIKE ? ORDER BY path`, `${prefix}%`,
    )) {
      const rest = v.parse(v.string(), row.path).slice(prefix.length);
      const slash = rest.indexOf('/');
      names.add(slash < 0 ? rest : rest.slice(0, slash));
    }

    return [...names];
  }

  async mkdir(): Promise<void> {}

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    this.ctx.storage.transactionSync(() => {
      this.exec(`DELETE FROM probe_file_ranges WHERE path = ?`, path);
      this.exec(
        `INSERT INTO probe_file_ranges (path, start, bytes) VALUES (?, 0, ?)`, path, bytes.slice().buffer,
      );
    });
  }

  async readFile(path: string, opts?: { encoding?: string }): Promise<Uint8Array | string> {
    const stat = await this.stat(path);

    if (stat === null) throw new Error(`ENOENT: ${path}`);
    const whole = await this.readRange(path, 0, stat.size);

    return opts?.encoding === undefined ? whole : new TextDecoder().decode(whole);
  }

  async unlink(path: string): Promise<void> {
    this.exec(`DELETE FROM probe_file_ranges WHERE path = ?`, path);
  }

  /** Every path with size and digest, folded a range at a time so verification never holds a file. */
  async digests(): Promise<{ path: string; size: number; digest: string }[]> {
    const out: { path: string; size: number; digest: string }[] = [];

    for (const row of this.exec(
      `SELECT DISTINCT path FROM probe_file_ranges ORDER BY path`,
    )) {
      const path = v.parse(v.string(), row.path);
      const stat = await this.stat(path);

      if (stat === null) continue;
      const hash = new crypto.DigestStream('SHA-256');
      const writer = hash.getWriter();

      for (let offset = 0; offset < stat.size; offset += PROBE_FRAME_BYTES) {
        await writer.write(
          await this.readRange(path, offset, Math.min(PROBE_FRAME_BYTES, stat.size - offset)),
        );
      }

      await writer.close();
      const digest = Array.from(new Uint8Array(await hash.digest), (byte) => byte.toString(16).padStart(2, '0'));
      out.push({ path, size: stat.size, digest: digest.join('') });
    }

    return out;
  }

  private exec(query: string, ...bindings: SqlStorageValue[]): Record<string, SqlStorageValue>[] {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray();
  }
}

/** A refusal is reported, not thrown: the production source catches it too (`deliverCloudFork`). */
export interface ForkDeliveryReport {
  sent: number;
  nextSeq: number;
  /** The source's own fold up to `nextSeq`; the target's stored digest must equal it. */
  stream: string;
  staged: number;
  settled: number;
  fork: ForkResult | null;
  refusal: string | null;
}

export type ForkDeliveryStop =
  | 'files'
  /** Mid-file: the one boundary a transfer cannot resume from (the whole-file digest lives in the activation). */
  | 'range'
  | 'commit'
  | 'end';

export type ForkCorruption =
  | 'frame'
  /** Resealed, so only the whole-file digest at the last range can see it. */
  | 'resealed';

export interface ForkDeliveryRequest {
  target: string;
  from: number;
  stop: ForkDeliveryStop;
  corrupt?: ForkCorruption;
}

abstract class ForkProbeDO extends DurableObject<Cloudflare.Env> {
  protected readonly sql: SqlExecutor = <Row,>(
    query: TemplateStringsArray, ...values: SqlValue[]
  ): Row[] => this.ctx.storage.sql.exec<Row & Record<string, SqlStorageValue>>(query.join('?'), ...values).toArray();

  protected readonly plane = new ProbeFilePlane(this.ctx);
  private schemaReady = false;

  protected ensureSchema(): void {
    if (this.schemaReady) return;
    initWorkspaceSchema({
      execRaw: (ddl: string) => { this.ctx.storage.sql.exec(ddl); },
      sql: this.sql,
      exec: this.ctx.storage.sql,
    });
    this.ctx.storage.sql.exec(ProbeFilePlane.DDL);
    this.schemaReady = true;
  }
}

export class ForkSourceProbeDO extends ForkProbeDO {
  /**
   * Conversation rows go through the production session writers, not hand INSERTs. The transfer id is
   * stored, not minted per call: a resumed run must regenerate the same sealed stream.
   */
  async seed(): Promise<void> {
    this.ensureSchema();

    if (await this.ctx.storage.get<string>('transferId') !== undefined) return;

    const transferId = `probe-transfer-${this.ctx.id.toString().slice(0, 8)}`;
    void this.sql`DELETE FROM workspace_identity`;
    void this.sql`INSERT INTO workspace_identity (id, name, created_at)
      VALUES (${'source-workspace'}, ${PROBE_SOURCE_NAME}, ${1_760_000_000_000})`;
    const actor = new WorkspaceActorDirectory(this.sql, { workspaceId: 'source-workspace', ownerUserId: '' }).createMain({ name: PROBE_SOURCE_NAME });
    actor.config.setModel('probe/model-1');
    actor.config.set('reasoning_effort', 'high — long enough that this row needs a frame of its own');
    void this.sql`INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at)
      VALUES (${'probe_tool'}, ${'Counts what a fork carried.'}, ${null},
              ${'export default () => 1;'}, ${'workspace'}, ${1_760_000_000_001}, ${1_760_000_000_002})`;

    for (const n of [1, 2]) {
      void this.sql`INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
        VALUES (${`chunk-${n}`}, ${'memory/notes.md'}, ${n}, ${n + 1}, ${`hash-${n}`},
                ${`Chunk ${n} of the parent's memory index, wide enough to need its own frame.`},
                ${1_760_000_000_003})`;
    }

    const history = new SessionHistory({
      actor,
      sql: this.sql,
      transactionSync: <Result>(write: () => Result): Result => this.ctx.storage.transactionSync(write),
      files: async () => ({ vfs: this.plane, artifactDirectory: PROBE_ARTIFACTS }),
    });

    const transcript = history.transcript(CHAT_SESSION_ID);

    const turns = [
      { id: 'm1', role: 'user', text: 'Fork me.' },
      { id: 'm2', role: 'assistant', text: 'Reading the workspace first.' },
      { id: PROBE_CUT_MESSAGE_ID, role: 'assistant', text: 'Done. This is the cut point.' },
    ] as const;

    let parentId: string | null = null;

    for (const [index, turn] of turns.entries()) {
      const reference = await history.append({
        id: turn.id,
        message: { role: turn.role, content: turn.text },
        origin: turn.role === 'user' ? 'input' : 'output',
        turnId: null,
        assertOwner: () => actor.assertCurrent(),
      });

      transcript.record({
        id: turn.id, parentId, role: turn.role, turnId: null, runId: null, metadata: null,
        parts: [{ messageId: reference.messageId, partNo: 0 }],
      });

      parentId = turn.id;
      void this.sql`UPDATE conversation_entries SET recorded_at = ${PROBE_CUT_RECORDED_AT - (turns.length - 1 - index) * 1000}
        WHERE actor_id = ${actor.actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${turn.id}`;
    }

    await this.plane.writeFile(SOUL_PATH, SOUL_CONTENT);
    await this.plane.writeFile('memory/notes.md', 'Everything the parent learned. '.repeat(7));
    await this.plane.writeFile('memory/deep/proof.bin', new Uint8Array(PROBE_FRAME_BYTES * 4).fill(0x7a));
    await this.ctx.storage.put('transferId', transferId);
  }

  async sourceFiles(): Promise<{ path: string; size: number; digest: string }[]> {
    this.ensureSchema();

    return this.plane.digests();
  }

  /** Regenerates the stream from own rows each run (an interrupted activation lost its generator). */
  async deliver(request: ForkDeliveryRequest): Promise<ForkDeliveryReport> {
    this.ensureSchema();
    const transferId = await this.ctx.storage.get<string>('transferId');

    if (transferId === undefined) throw new Error('fork source probe was not seeded');
    const target = this.env.FORK_TARGET.get(this.env.FORK_TARGET.idFromName(request.target));

    const report: ForkDeliveryReport = {
      sent: 0, nextSeq: request.from, stream: FORK_STREAM_SEED,
      staged: 0, settled: 0, fork: null, refusal: null,
    };

    try {
      for await (const frame of forkTransferFrames({
        sql: this.sql,
        // Forking under any other actor would read an empty transcript and pass vacuously.
        actor: openWorkspaceMainActor(this.sql),
        vfs: this.plane,
        artifactDirectory: PROBE_ARTIFACTS,
        untilMessageId: PROBE_CUT_MESSAGE_ID,
        transferId,
        frameBytes: PROBE_FRAME_BYTES,
      })) {
        if (frame.seq < request.from) {
          report.stream = foldForkStream(report.stream, frame.digest);
          continue;
        }

        if (request.stop === 'files' && frame.kind === 'file') break;

        if (request.stop !== 'end' && frame.kind === 'commit') break;

        const outcome = await target.accept(
          frame.seq === request.from && request.corrupt !== undefined
            ? corruptFrame(frame, request.corrupt)
            : frame,
        );

        report.sent += 1;
        report.nextSeq = frame.seq + 1;

        // The commit's own digest is not folded: it seals the value.
        if (frame.kind !== 'commit') report.stream = foldForkStream(report.stream, frame.digest);

        if (outcome.status === 'staged') report.staged += 1;
        else {
          if (outcome.status === 'settled') report.settled += 1;
          report.fork = outcome.result;
        }

        if (request.stop === 'range' && frame.kind === 'file' && !frame.last) break;
      }
    } catch (cause) {
      report.refusal = cause instanceof Error ? cause.message : String(cause);
    }

    return report;
  }
}

function corruptFrame(frame: ForkFrame, how: ForkCorruption): ForkFrame {
  if (frame.kind !== 'file') throw new Error(`frame ${frame.seq} is a ${frame.kind} frame, not a file frame`);
  const bytes = frame.bytes.slice();
  bytes[0] = bytes[0] ^ 0xff;

  return how === 'frame' ? { ...frame, bytes } : sealForkFrame({ ...frame, bytes });
}

export interface ForkTargetState {
  lineage: ForkLineageRow | null;
  identity: { id: string; name: string; mission: string | null } | null;
  displayName: string | null;
  entries: number;
  markers: number;
  messages: number;
  contextMembers: number;
  configRows: number;
  craftedTools: number;
  memoryChunks: number;
  files: { path: string; size: number; digest: string }[];
}

export class ForkTargetProbeDO extends ForkProbeDO {
  /** Per-activation only, as in `rawCopyFromFork`: a file spanning frames is staged across calls. */
  private receiver: ForkTransferReceiver | null = null;

  /** Driven as `rawCopyFromFork` does: identity row first, publication inside `transactionSync`. */
  async accept(frame: ForkFrame): Promise<
    { status: 'staged' | 'settled' | 'published'; result: ForkResult | null }
  > {
    this.ensureSchema();

    if (this.sql<{ x: number }>`SELECT 1 AS x FROM workspace_identity LIMIT 1`.length === 0) {
      void this.sql`INSERT INTO workspace_identity (id, name, created_at)
        VALUES (${this.ctx.id.toString()}, ${'unpublished-target'}, ${1_760_000_000_100})`;
      new WorkspaceActorDirectory(this.sql, { workspaceId: this.ctx.id.toString(), ownerUserId: '' }).createMain({ name: 'unpublished-target' });
    }

    this.receiver ??= new ForkTransferReceiver(
      new ForkTargetWriter(this.sql, this.plane, {
        workspaceId: this.ctx.id.toString(),
        workspaceName: 'fork-target',
        artifactDirectory: PROBE_ARTIFACTS,
        transaction: (rows) => this.ctx.storage.transactionSync(rows),
      }),
      new NativeSinkPlan(this.plane.native, frame.transferId, {
        // SOUL publishes through the protected write, not a staged-temp rename.
        owns: (targetPath) => targetPath === SOUL_PATH,
        publish: async (targetPath, bytes) => {
          await this.plane.writeFile(targetPath, bytes);

          return { mission: summarizeSoulBytes(bytes) };
        },
      }),
    );
    const outcome = await this.receiver.accept(frame);

    return outcome.status === 'staged'
      ? { status: 'staged', result: null }
      : { status: outcome.status, result: outcome.result };
  }

  /** Read through the production accessor so the test asserts the value the receiver uses. */
  async cursor(): Promise<ForkStaging | null> {
    this.ensureSchema();

    return new ForkStagingState(this.sql).read();
  }

  async state(): Promise<ForkTargetState> {
    this.ensureSchema();
    const tally = (rows: { count: number }[]): number => rows[0]?.count ?? 0;

    return {
      lineage: readForkLineage(this.sql),
      identity: this.sql<{ id: string; name: string; mission: string | null }>`
        SELECT id, name, mission FROM workspace_identity LIMIT 1`[0] ?? null,
      displayName: openWorkspaceMainActor(this.sql).config.getDisplayName(),
      entries: tally(this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM conversation_entries WHERE role <> ${'system'}`),
      markers: tally(this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM conversation_entries WHERE role = ${'system'}`),
      messages: tally(this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM session_messages`),
      contextMembers: tally(this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM context_memberships WHERE to_revision IS NULL`),
      configRows: tally(this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM actor_config`),
      craftedTools: tally(this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM crafted_tools`),
      memoryChunks: tally(this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM memory_chunks`),
      files: await this.plane.digests(),
    };
  }
}
