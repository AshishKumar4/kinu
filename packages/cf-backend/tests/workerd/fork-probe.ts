/**
 * A hosted fork, run across two real Durable Objects that are really evicted.
 *
 * WHY THIS FILE HAS TO EXIST. `identity/fork-transfer.ts` is a protocol between
 * TWO Durable Objects, and the bun suite runs both halves in one process where
 * neither can end. What bun cannot host is the platform fact the protocol
 * actually stands on: a Durable Object's activation is not the lifetime of the
 * work it is doing. The receiver's cursor — which frame is next, the rolling
 * digest of the frames that arrived, what the target has staged, whether the
 * fork already published — has to outlive an isolate reset, because the source
 * keeps sending frames after one. Instance fields do not, and a green bun suite
 * says nothing about it.
 *
 * So the probes here are the PRODUCTION halves, not stand-ins:
 * `forkTransferFrames` reads the source object's own SQLite and its own file
 * plane; `ForkTransferReceiver` over `ForkTargetWriter` and `NativeSinkPlan`
 * stages into the target object's own SQLite and file plane, with the
 * publication inside `ctx.storage.transactionSync` exactly as `rawCopyFromFork`
 * drives it. Only three things are local: the tagged-template SQL bridge (the
 * assertion `bindAgentSql` makes in production, made here because the Agents SDK
 * is not hosted in this worker), the file plane (Nimbus lives behind
 * NIMBUS_SESSION, which this pool does not bind), and the delivery driver.
 *
 * THE DRIVER IS RESUMABLE ON PURPOSE. The test evicts every object between two
 * frames, so the source's generator dies with the target's cursor. `deliver`
 * therefore regenerates the frame stream from the source's own rows and skips
 * what already landed — which is what makes the target's answer evidence: a
 * receiver that did not resume at the same frame with the same rolling digest
 * refuses the next one.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  FORK_STREAM_SEED, ForkStagingState, ForkTargetWriter, ForkTransferReceiver, NativeSinkPlan, SOUL_PATH,
  foldForkStream, forkTransferFrames, initWorkspaceSchema, readForkLineage, sealForkFrame,
  summarizeSoulBytes,
  type ForkFrame, type ForkLineageRow, type ForkNativeFilePort, type ForkResult,
  type ForkStaging, type SqlExecutor, type VFS, type VfsEntryStat,
} from '@kinu.run/core';

/**
 * Bytes of payload per frame.
 *
 * Small on purpose. Production passes `FORK_FRAME_BYTES` (8 MiB), and at that
 * size this fixture would cross in one frame per section, so the boundaries the
 * test evicts at would not exist. Sixty-four bytes makes each one real: the rows
 * span several frames, `memory/notes.md` spans four, and the protected SOUL
 * destination still fits the single frame it is allowed.
 */
const PROBE_FRAME_BYTES = 64;

/** The cut point: the newest of the three seeded pane rows. */
export const PROBE_CUT_MESSAGE_ID = 'm3';

/** The source workspace's own name, so the published lineage is asserted
 *  against a value the test did not invent. */
export const PROBE_SOURCE_NAME = 'fork-source';

const SOUL_CONTENT = '# Mission\nProve a fork survives an eviction.\n';

/** The mission the target must end up carrying, read from SOUL's bytes by the
 *  same summarizer the protected publisher uses. */
export const PROBE_SOUL_MISSION = summarizeSoulBytes(new TextEncoder().encode(SOUL_CONTENT));

/** The SDK session provider's own DDL — the same statement
 *  `ForkTargetWriter.ensurePaneTable` runs, because a source workspace that has
 *  served a hosted turn has this table and its ancestry is read from it. */
const PANE_DDL = `CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;

/** workerd's streaming digest, which is how an object hashes bytes it must not
 *  hold. It lives on the runtime's `crypto`, and the ambient `Crypto` type this
 *  test project compiles against does not carry it — so the platform member is
 *  declared here rather than asserted away at the call site. */
interface WorkerdDigestStream extends WritableStream<ArrayBufferView | ArrayBuffer> {
  readonly digest: Promise<ArrayBuffer>;
}
declare const crypto: Crypto & {
  DigestStream: new (algorithm: string) => WorkerdDigestStream;
};

/**
 * The probe's workspace file plane: one durable BLOB row per written range.
 *
 * Ranges rather than whole files, for the reason the wire is ranged at all — a
 * plane that could only hold a file whole would put the file back into the
 * isolate the framing exists to keep it out of. Both directions stay bounded: a
 * write stores the range it was handed, and `readRange` answers out of SQLite's
 * own `substr`, so reading a range costs the range.
 *
 * A range is bound as `bytes.slice().buffer` rather than `bytes.buffer`: a
 * frame's payload is a VIEW over a larger buffer, and binding the view's own
 * buffer would store far more than the range.
 *
 * The four native operations are exactly the ones
 * `createNimbusWorkspaceForkSink` serves from Nimbus in production, and the
 * rename runs inside `transactionSync` because that rename IS the atomic
 * publication of one staged file.
 */
class ProbeFilePlane implements VFS {
  static readonly DDL = `CREATE TABLE IF NOT EXISTS probe_file_ranges (
    path  TEXT    NOT NULL,
    start INTEGER NOT NULL,
    bytes BLOB    NOT NULL,
    PRIMARY KEY (path, start)
  )`;

  constructor(private readonly ctx: DurableObjectState) {}

  /** The fork's native file authority over this plane. Deliberately separate
   *  from the VFS: range writes and rename-to-publish are not ordinary
   *  workspace writes. */
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
      // The same ranged read the VFS serves. The fork's digest read-back goes
      // through it, so verifying a staged file costs one range at a time here
      // too.
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

  /**
   * One byte range, clipped inside SQLite.
   *
   * Each stored range answers only the part of itself the caller asked for, so
   * a read never materializes a range wider than the request even when the
   * plane holds the file in one row.
   */
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
    // Insertion-ordered, deduplicated: several ranges of several files share one
    // directory name, and the walk wants each name once.
    const names = new Set<string>();
    for (const row of this.exec(
      `SELECT DISTINCT path FROM probe_file_ranges WHERE path LIKE ? ORDER BY path`, `${prefix}%`,
    )) {
      const rest = String(row.path).slice(prefix.length);
      const slash = rest.indexOf('/');
      names.add(slash < 0 ? rest : rest.slice(0, slash));
    }
    return [...names];
  }

  /** Directories are implied by the paths under them, which is what the walk in
   *  `forkFilePaths` reads them as. */
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

  /** The base contract's whole-file read. The streamed fork never takes this
   *  path — it reads and writes ranges — but a VFS that cannot answer it is not
   *  a VFS. */
  async readFile(path: string, opts?: { encoding?: string }): Promise<Uint8Array | string> {
    const stat = await this.stat(path);
    if (stat === null) throw new Error(`ENOENT: ${path}`);
    const whole = await this.readRange(path, 0, stat.size);
    return opts?.encoding === undefined ? whole : new TextDecoder().decode(whole);
  }

  async unlink(path: string): Promise<void> {
    this.exec(`DELETE FROM probe_file_ranges WHERE path = ?`, path);
  }

  /**
   * Every path in the plane with its size and digest.
   *
   * Folded a range at a time through the platform's own streaming digest, so
   * even the verification never holds a file — the property the transfer is
   * asserted on has to hold in the assertion too.
   */
  async digests(): Promise<{ path: string; size: number; digest: string }[]> {
    const out: { path: string; size: number; digest: string }[] = [];
    for (const row of this.exec(
      `SELECT DISTINCT path FROM probe_file_ranges ORDER BY path`,
    )) {
      const path = String(row.path);
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

  /** The platform's own row vocabulary; callers narrow each field they read. */
  private exec(query: string, ...bindings: SqlStorageValue[]): Record<string, SqlStorageValue>[] {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray();
  }
}

/** What one delivery run did. A refusal is reported rather than thrown: it is
 *  an outcome this test asserts on, and the production source catches it too —
 *  `deliverCloudFork` destroys the target on it. */
export interface ForkDeliveryReport {
  /** Frames handed to the target this run. */
  sent: number;
  /** The frame the target must expect next. A resumed run starts here. */
  nextSeq: number;
  /** The source's OWN fold over every frame up to `nextSeq`. The target's
   *  stored digest has to equal this, and the commit the source seals later is
   *  the continuation of it — so a receiver that resumed from anything else
   *  cannot reach a matching commit. */
  stream: string;
  staged: number;
  /** Frames the target answered for a transfer it had already published. */
  settled: number;
  /** The fork the target answered with, whether it published it on this run or
   *  had already published it before. */
  fork: ForkResult | null;
  refusal: string | null;
}

/** Where a delivery run stops, so the test can end the activation at a boundary
 *  the protocol actually has. */
export type ForkDeliveryStop =
  /** Before the first file frame — the row/file boundary. */
  | 'files'
  /** After a range that does NOT complete its file — the one boundary a
   *  transfer cannot resume from, because the whole-file digest folding those
   *  ranges lives in the activation. */
  | 'range'
  /** Before the commit — the last-frame/publication boundary. */
  | 'commit'
  | 'end';

/** How frame `from` is damaged on its way out. */
export type ForkCorruption =
  /** One payload byte flipped, the frame's seal left alone: the receiver's own
   *  per-frame digest is what refuses it. */
  | 'frame'
  /** One payload byte flipped and the frame RESEALED, so every per-frame check
   *  passes and the only thing that can see it is the whole-file digest read
   *  back out of the staging at the last range. */
  | 'resealed';

export interface ForkDeliveryRequest {
  target: string;
  /** First frame to send. Frames before it already landed. */
  from: number;
  stop: ForkDeliveryStop;
  /** Damage frame `from`. Later frames go out intact, so a corruption the
   *  per-frame digest cannot see reaches the check that can. */
  corrupt?: ForkCorruption;
}

export class ForkSourceProbeDO extends DurableObject<Cloudflare.Env> {
  // SAFETY: the same assertion `bindAgentSql` (runtime.ts:113) makes, at the
  // same boundary and for the same reason. `SqlExecutor` and the platform's
  // `sql.exec` are one tagged-template protocol; `SqlExecutor` additionally
  // admits ArrayBuffer, which Durable Object SQLite binds at runtime and does
  // not type. The Agents SDK is not hosted in this worker.
  private readonly sql = ((
    query: TemplateStringsArray, ...values: SqlStorageValue[]
  ) => this.ctx.storage.sql.exec(query.join('?'), ...values).toArray()) as SqlExecutor;

  private readonly plane = new ProbeFilePlane(this.ctx);
  private schemaReady = false;

  /**
   * One workspace worth forking: identity, config, a crafted tool, memory
   * chunks, a three-row pane ancestry and three files.
   *
   * The transfer id is stored in the object's own storage rather than minted per
   * call, because a resumed run has to regenerate the SAME stream and the id is
   * part of every frame's sealed preimage.
   */
  async seed(): Promise<void> {
    this.ensureSchema();
    if (await this.ctx.storage.get<string>('transferId') !== undefined) return;

    const transferId = `probe-transfer-${this.ctx.id.toString().slice(0, 8)}`;
    void this.sql`DELETE FROM workspace_identity`;
    void this.sql`INSERT INTO workspace_identity (id, name, created_at)
      VALUES (${'source-workspace'}, ${PROBE_SOURCE_NAME}, ${1_760_000_000_000})`;
    void this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES (${'model'}, ${'probe/model-1'})`;
    void this.sql`INSERT OR REPLACE INTO agent_config (key, value)
      VALUES (${'reasoning_effort'}, ${'high — long enough that this row needs a frame of its own'})`;
    void this.sql`INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at)
      VALUES (${'probe_tool'}, ${'Counts what a fork carried.'}, ${null},
              ${'export default () => 1;'}, ${'workspace'}, ${1_760_000_000_001}, ${1_760_000_000_002})`;
    for (const n of [1, 2]) {
      void this.sql`INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
        VALUES (${`chunk-${n}`}, ${'memory/notes.md'}, ${n}, ${n + 1}, ${`hash-${n}`},
                ${`Chunk ${n} of the parent's memory index, wide enough to need its own frame.`},
                ${1_760_000_000_003})`;
    }
    this.ctx.storage.sql.exec(PANE_DDL);
    const pane = [
      { id: 'm1', parent: null, role: 'user', text: 'Fork me.' },
      { id: 'm2', parent: 'm1', role: 'assistant', text: 'Reading the workspace first.' },
      { id: PROBE_CUT_MESSAGE_ID, parent: 'm2', role: 'assistant', text: 'Done. This is the cut point.' },
    ];
    pane.forEach((row, index) => {
      void this.sql`INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
        VALUES (${row.id}, ${'default'}, ${row.parent}, ${row.role},
                ${JSON.stringify({ id: row.id, role: row.role, parts: [{ type: 'text', text: row.text }] })},
                ${`2026-01-01 00:00:0${index + 1}.000`})`;
    });

    await this.plane.writeFile(SOUL_PATH, SOUL_CONTENT);
    await this.plane.writeFile('memory/notes.md', 'Everything the parent learned. '.repeat(7));
    // Four ranges exactly, so an eviction after the first one leaves three to go.
    await this.plane.writeFile('memory/deep/proof.bin', new Uint8Array(PROBE_FRAME_BYTES * 4).fill(0x7a));
    await this.ctx.storage.put('transferId', transferId);
  }

  /** This workspace's own files, so the test compares the target's bytes with
   *  the source's rather than with a hardcoded digest. */
  async sourceFiles(): Promise<{ path: string; size: number; digest: string }[]> {
    this.ensureSchema();
    return this.plane.digests();
  }

  /**
   * Send frames to the target, starting at `from` and stopping at `stop`.
   *
   * The stream is REGENERATED from this workspace's own rows on every run,
   * because an activation that was interrupted took its generator with it.
   * Frames before `from` are produced and skipped, so what does go out carries
   * the seqs and digests the target already folded — the resumption is real, not
   * a re-sent prefix.
   */
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
        vfs: this.plane,
        untilMessageId: PROBE_CUT_MESSAGE_ID,
        transferId,
        targetAuthority: 'pane',
        frameBytes: PROBE_FRAME_BYTES,
      })) {
        // Frames that landed before this run are folded but not re-sent: the
        // digest the target resumed with covers them.
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
        // The commit's own digest is not folded — it seals the value, so folding
        // it would leave the two halves computing different sequences.
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

  private ensureSchema(): void {
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

/** One frame with a payload byte flipped: as a transport would deliver it, or
 *  resealed as a sender that sent different bytes would. */
function corruptFrame(frame: ForkFrame, how: ForkCorruption): ForkFrame {
  if (frame.kind !== 'file') throw new Error(`frame ${frame.seq} is a ${frame.kind} frame, not a file frame`);
  const bytes = frame.bytes.slice();
  bytes[0] = bytes[0]! ^ 0xff;
  return how === 'frame' ? { ...frame, bytes } : sealForkFrame({ ...frame, bytes });
}

/** Everything an owner could observe about the target. Read-only: asking does
 *  not advance the transfer. */
export interface ForkTargetState {
  lineage: ForkLineageRow | null;
  identity: { id: string; name: string; mission: string | null } | null;
  displayName: string | null;
  paneRows: number;
  plainRows: number;
  markers: number;
  configRows: number;
  craftedTools: number;
  memoryChunks: number;
  files: { path: string; size: number; digest: string }[];
}

export class ForkTargetProbeDO extends DurableObject<Cloudflare.Env> {
  // SAFETY: the tagged contract guarantees one `?` placeholder per interpolated
  // value (`join('?')`), DO SQLite binds the same `SqlStorageValue` vocabulary
  // `SqlExecutor` declares, and `toArray()` returns `Record<string,
  // SqlStorageValue>` rows — the row shape the contract's callers parse per
  // field. The cast bridges only the generic row parameter the platform API
  // cannot carry.
  private readonly sql = ((
    query: TemplateStringsArray, ...values: SqlStorageValue[]
  ) => this.ctx.storage.sql.exec(query.join('?'), ...values).toArray()) as SqlExecutor;

  private readonly plane = new ProbeFilePlane(this.ctx);
  private schemaReady = false;

  /**
   * One unpublished transfer's receiver, held for this ACTIVATION only —
   * `rawCopyFromFork` holds it the same way and for the same reason: a file that
   * spans frames is hashed and staged across several calls.
   */
  private receiver: ForkTransferReceiver | null = null;

  /**
   * One frame, driven exactly as `rawCopyFromFork` drives it: the identity row
   * first (in production the file plane's precondition, and deliberately the
   * only identity datum before publication), then the receiver, with the
   * publication inside `transactionSync`.
   */
  async accept(frame: ForkFrame): Promise<
    { status: 'staged' | 'settled' | 'published'; result: ForkResult | null }
  > {
    this.ensureSchema();
    if (this.sql<{ x: number }>`SELECT 1 AS x FROM workspace_identity LIMIT 1`.length === 0) {
      void this.sql`INSERT INTO workspace_identity (id, name, created_at)
        VALUES (${this.ctx.id.toString()}, ${'unpublished-target'}, ${1_760_000_000_100})`;
    }

    this.receiver ??= new ForkTransferReceiver(
      new ForkTargetWriter(this.sql, this.plane, {
        workspaceId: this.ctx.id.toString(),
        workspaceName: 'fork-target',
        targetAuthority: 'pane',
        transaction: (rows) => this.ctx.storage.transactionSync(rows),
      }),
      new NativeSinkPlan(this.plane.native, frame.transferId, {
        // SOUL publishes through the protected write in production rather than
        // by renaming a staged temp, and it carries the mission back from the
        // one frame it is allowed to occupy.
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

  /**
   * The durable cursor this transfer stands on, read straight out of the row the
   * receiver resumes from.
   *
   * Read through the production accessor rather than by querying columns here,
   * so the test is asserting on the same value the receiver uses and not on a
   * transcription of it.
   */
  async cursor(): Promise<ForkStaging | null> {
    this.ensureSchema();
    return new ForkStagingState(this.sql).read();
  }

  async state(): Promise<ForkTargetState> {
    this.ensureSchema();
    const pane = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = ${'table'} AND name = ${'assistant_messages'}`.length > 0;
    const tally = (rows: { count: number }[]): number => rows[0]?.count ?? 0;
    return {
      lineage: readForkLineage(this.sql),
      identity: this.sql<{ id: string; name: string; mission: string | null }>`
        SELECT id, name, mission FROM workspace_identity LIMIT 1`[0] ?? null,
      displayName: this.sql<{ value: string }>`
        SELECT value FROM agent_config WHERE key = ${'display_name'}`[0]?.value ?? null,
      paneRows: !pane ? 0 : tally(this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM assistant_messages WHERE role <> ${'system'}`),
      markers: !pane ? 0 : tally(this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM assistant_messages WHERE role = ${'system'}`),
      plainRows: tally(this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM messages`),
      configRows: tally(this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM agent_config`),
      craftedTools: tally(this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM crafted_tools`),
      memoryChunks: tally(this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM memory_chunks`),
      files: await this.plane.digests(),
    };
  }

  private ensureSchema(): void {
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
