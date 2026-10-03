/**
 * A hosted fork across two real Durable Objects, evicted between frames: the receiver's cursor and Nimbus's import
 * must outlive an isolate reset, which bun cannot host. The probes run the production halves over real Nimbus stores
 * (the fork's source pins and exports, the target imports); only the delivery driver is local, and it resumes by
 * regenerating the stream with the answers the target gave it recorded.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  agentArtifactDirectory, agentHome, CHAT_SESSION_ID, MAIN_AGENT,
  FORK_STREAM_SEED, ForkStagingState, ForkTargetWriter, ForkTransferReceiver,
  foldForkStream, createWorkspaceForkSink, createWorkspaceForkSource, writeWorkspaceSoul, forkTransferFrames, initWorkspaceSchema, nimbusSessionFiles,
  readForkLineage, readMission, SessionHistory, summarizeSoul, WorkspaceActorDirectory, openWorkspaceMainActor,
  type ForkFrame, type ForkFrameReply, type ForkLineageRow, type ForkResult, type ForkStaging, type SqlExecutor, type SqlValue,
  WORKSPACE_ROOT,
} from '@kinu.run/core';
import { workspaceBoxFiles } from '@kinu.run/core/workspace';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

/** Small on purpose: every chunk crosses in a frame of its own, so a file's chunks are several frames. */
const PROBE_FRAME_BYTES = 64;

export const PROBE_CUT_MESSAGE_ID = 'm3';

const PROBE_HOME = agentHome(MAIN_AGENT);

const PROBE_ARTIFACTS = agentArtifactDirectory(PROBE_HOME);

/** Fixture restamp of the cut entry: the target publishes the cut entry's stamp as the fork point. */
export const PROBE_CUT_RECORDED_AT = Date.parse('2026-01-01T00:00:03.000Z');

export const PROBE_SOURCE_NAME = 'fork-source';

const SOUL_CONTENT = '# Mission\nProve a fork survives an eviction.\n';

export const PROBE_SOUL_MISSION = summarizeSoul(SOUL_CONTENT);

/** Several chunks of distinct bytes, so its import is a page and a run of chunk frames. */
const PROOF_BYTES = 256 * 1024;

/** A refusal is reported, not thrown: the production source catches it too (`deliverCloudFork`). */
export interface ForkDeliveryReport {
  sent: number;
  /** Frames of the stream this run went past, taken or answered: where the next run resumes. */
  position: number;
  /** The frame the target expects next. */
  nextSeq: number;
  /** The source's own fold of the frames taken; the target's stored digest must equal it. */
  stream: string;
  staged: number;
  wanted: number;
  settled: number;
  fork: ForkResult | null;
  refusal: string | null;
}

export type ForkDeliveryStop =
  | 'files'
  /** Past the first frame of chunks of an import that needs several: mid-way through its bytes. */
  | 'chunks'
  | 'commit'
  | 'end';

export type ForkCorruption =
  /** SOUL.md's or a page's content changed without resealing: the per-frame digest refuses it. */
  | 'frame'
  /** A chunk's bytes changed; its frame names it by hash, so Nimbus's re-hash refuses it. */
  | 'chunk';

export interface ForkDeliveryRequest {
  target: string;
  from: number;
  stop: ForkDeliveryStop;
  corrupt?: ForkCorruption;
}

export interface ProbeFile {
  path: string;
  size: number;
  digest: string;
}

abstract class ForkProbeDO extends DurableObject<Cloudflare.Env> {
  protected readonly sql: SqlExecutor = <Row,>(
    query: TemplateStringsArray, ...values: SqlValue[]
  ): Row[] => this.ctx.storage.sql.exec<Row & Record<string, SqlStorageValue>>(query.join('?'), ...values).toArray();

  private schemaReady = false;
  private opened: Promise<NimbusWorkspace> | undefined;
  protected readonly fileHost = {
    session: async () => ({ vfs: (await this.session()).vfs, sql: this.ctx.storage.sql }),
  };

  protected ensureSchema(): void {
    if (this.schemaReady) return;
    initWorkspaceSchema({
      execRaw: (ddl: string) => { this.ctx.storage.sql.exec(ddl); },
      sql: this.sql,
      exec: this.ctx.storage.sql,
      transactionSync: (write) => this.ctx.storage.transactionSync(write),
    });
    this.schemaReady = true;
  }

  /** This object's Nimbus store, with the main agent's home as a workspace is born with it. */
  protected session(): Promise<NimbusWorkspace> {
    this.opened ??= NimbusWorkspace.create({ sql: this.ctx.storage.sql, transactions: { storage: this.ctx.storage } })
      .then((workspace) => {
        const kernel = workspace.vfs.as(CRED_KERNEL);

        if (!kernel.exists(PROBE_HOME)) {
          kernel.mkdir(PROBE_HOME, { recursive: true });
          kernel.chown(PROBE_HOME, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
        }

        return workspace;
      });

    return this.opened;
  }

  protected async store(): Promise<SqliteVFS> {
    return (await this.session()).vfs;
  }

  protected async sealSoul(bytes: string | Uint8Array): Promise<void> {
    await writeWorkspaceSoul(this.fileHost, bytes);
  }

  /** Every file under the home with its size and digest, in path order. */
  async files(): Promise<ProbeFile[]> {
    const kernel = (await this.store()).as(CRED_KERNEL);
    const out: ProbeFile[] = [];

    const walk = async (directory: string): Promise<void> => {
      for (const entry of kernel.readdir(directory).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = `${directory}/${entry.name}`;

        if (kernel.lstat(path).type === 'directory') {
          await walk(path);
          continue;
        }

        const bytes = kernel.readFile(path);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())), (byte) => byte.toString(16).padStart(2, '0'));
        out.push({ path: path.slice(PROBE_HOME.length + 1), size: bytes.byteLength, digest: digest.join('') });
      }
    };

    await walk(PROBE_HOME);

    return out;
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
    void this.sql`INSERT INTO crafted_tools (name, description, code, created_at, updated_at)
      VALUES (${'probe_tool'}, ${'Counts what a fork carried.'},
              ${'export default () => 1;'}, ${1_760_000_000_001}, ${1_760_000_000_002})`;

    for (const n of [1, 2]) {
      void this.sql`INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text)
        VALUES (${`chunk-${n}`}, ${'memory/notes.md'}, ${n}, ${n + 1}, ${`hash-${n}`},
                ${`Chunk ${n} of the parent's memory index, wide enough to need its own frame.`})`;
    }

    const files = nimbusSessionFiles({
      files: workspaceBoxFiles(() => this.store()),
      ready: async () => undefined,
      exec: async () => { throw new Error('the fork probe runs no processes'); },
    }, { home: WORKSPACE_ROOT });

    const history = new SessionHistory({
      actor,
      sql: this.sql,
      transactionSync: <Result>(write: () => Result): Result => this.ctx.storage.transactionSync(write),
      files: async () => ({ vfs: files, artifactDirectory: PROBE_ARTIFACTS }),
    });

    const transcript = history.transcript(CHAT_SESSION_ID);

    const turns = [
      { id: 'm1', role: 'user', text: 'Fork me.' },
      { id: 'm2', role: 'assistant', text: 'Reading the workspace first.' },
      { id: PROBE_CUT_MESSAGE_ID, role: 'assistant', text: 'Done. This is the cut point.' },
    ] as const;

    for (const [index, turn] of turns.entries()) {
      const reference = await history.append({
        id: turn.id,
        message: { role: turn.role, content: turn.text },
        origin: turn.role === 'user' ? 'input' : 'output',
        turnId: null,
        assertOwner: () => actor.assertCurrent(),
      });

      transcript.record({
        id: turn.id, role: turn.role, turnId: null, runId: null, metadata: null,
        parts: [{ messageId: reference.messageId, partNo: 0 }],
      });

      void this.sql`UPDATE conversation_entries SET recorded_at = ${PROBE_CUT_RECORDED_AT - (turns.length - 1 - index) * 1000}
        WHERE actor_id = ${actor.actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${turn.id}`;
    }

    await this.sealSoul(SOUL_CONTENT);
    const user = (await this.store()).as(CRED_SESSION_USER);
    user.mkdir(`${PROBE_HOME}/memory/deep`, { recursive: true });
    user.writeFile(`${PROBE_HOME}/memory/notes.md`, 'Everything the parent learned. '.repeat(7));
    // Distinct bytes throughout, so its content chunks are several and none repeats.
    user.writeFile(`${PROBE_HOME}/memory/deep/proof.bin`, Uint8Array.from({ length: PROOF_BYTES }, (_, at) => (at * 2654435761) >>> 24));
    await this.ctx.storage.put('transferId', transferId);
  }

  /**
   * Regenerates the stream each run (an interrupted activation lost its generator), replaying the answers the target
   * gave the frames before `from`, so the regenerated frames are the ones it expects.
   */
  async deliver(request: ForkDeliveryRequest): Promise<ForkDeliveryReport> {
    this.ensureSchema();
    const transferId = await this.ctx.storage.get<string>('transferId');

    if (transferId === undefined) throw new Error('fork source probe was not seeded');
    const target = this.env.FORK_TARGET.get(this.env.FORK_TARGET.idFromName(request.target));
    const answers = (await this.ctx.storage.get<(string[] | null)[]>(`answers:${request.target}`)) ?? [];

    const report: ForkDeliveryReport = {
      sent: 0, position: request.from, nextSeq: 0, stream: FORK_STREAM_SEED,
      staged: 0, wanted: 0, settled: 0, fork: null, refusal: null,
    };

    const frames = forkTransferFrames({
      sql: this.sql,
      // Forking under any other actor would read an empty transcript and pass vacuously.
      actor: openWorkspaceMainActor(this.sql),
      vfs: createWorkspaceForkSource(this.fileHost),
      artifactDirectory: PROBE_ARTIFACTS,
      untilMessageId: PROBE_CUT_MESSAGE_ID,
      transferId,
      frameBytes: PROBE_FRAME_BYTES,
    });

    let reply: ForkFrameReply | undefined;
    let chunkFrames = 0;

    try {
      for (let next = await frames.next(), index = 0; !next.done; next = await frames.next(reply), index += 1) {
        const frame = next.value;

        if (index < request.from) {
          const want = answers[index] ?? null;
          reply = want === null ? undefined : { want };

          if (want === null) taken(report, frame);

          continue;
        }

        if (request.stop === 'files' && (frame.kind === 'soul' || frame.kind === 'page' || frame.kind === 'chunks')) break;

        if (request.stop !== 'end' && frame.kind === 'commit') break;

        if (request.stop === 'chunks' && frame.kind === 'chunks' && chunkFrames === 1) break;

        const outcome = await target.accept(index === request.from && request.corrupt !== undefined ? corruptFrame(frame, request.corrupt) : frame);

        report.sent += 1;
        report.position = index + 1;
        answers[index] = outcome.status === 'want' ? outcome.hashes : null;
        await this.ctx.storage.put(`answers:${request.target}`, answers);
        reply = outcome.status === 'want' ? { want: outcome.hashes } : undefined;

        if (frame.kind === 'chunks') chunkFrames += 1;

        if (outcome.status === 'want') {
          report.wanted += 1;
          continue;
        }

        taken(report, frame);

        if (outcome.status === 'staged') report.staged += 1;
        else {
          if (outcome.status === 'settled') report.settled += 1;
          report.fork = outcome.result;
        }
      }
    } catch (cause) {
      report.refusal = cause instanceof Error ? cause.message : String(cause);
    } finally {
      await frames.return(undefined);
    }

    return report;
  }
}

/** A frame the target took: the next it expects, and the fold (the commit's own digest seals the value, unfolded). */
function taken(report: ForkDeliveryReport, frame: ForkFrame): void {
  report.nextSeq = frame.seq + 1;

  if (frame.kind !== 'commit') report.stream = foldForkStream(report.stream, frame.digest);
}

function corruptFrame(frame: ForkFrame, how: ForkCorruption): ForkFrame {
  if (how === 'chunk') {
    if (frame.kind !== 'chunks') throw new Error(`frame ${frame.seq} is a ${frame.kind} frame, not a frame of chunks`);

    return { ...frame, chunks: frame.chunks.map((chunk) => ({ hash: chunk.hash, data: chunk.data.map((byte) => byte ^ 0xff) })) };
  }

  if (frame.kind === 'soul') return { ...frame, bytes: frame.bytes.map((byte) => byte ^ 0xff) };

  if (frame.kind !== 'page') throw new Error(`frame ${frame.seq} is a ${frame.kind} frame, not SOUL.md or a page`);

  return { ...frame, page: { ...frame.page, rows: frame.page.rows.map((row) => ({ ...row, mtime: row.mtime + 1 })) } };
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
  files: ProbeFile[];
}

/** The identity row and the mission every listing reads, which is the soul's. */
function identityWithMission(sql: SqlExecutor): { id: string; name: string; mission: string | null } | null {
  const row = sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity LIMIT 1`[0];

  return row === undefined ? null : { ...row, mission: readMission(sql) };
}

export class ForkTargetProbeDO extends ForkProbeDO {
  /** Per-activation only, as in `rawCopyFromFork`. */
  private receiver: ForkTransferReceiver | null = null;

  /** Driven as `rawCopyFromFork` does: identity row first, publication inside `transactionSync`. */
  async accept(frame: ForkFrame): Promise<
    | { status: 'staged' | 'settled' | 'published'; result: ForkResult | null }
    | { status: 'want'; hashes: string[] }
  > {
    this.ensureSchema();

    if (this.sql<{ x: number }>`SELECT 1 AS x FROM workspace_identity LIMIT 1`.length === 0) {
      void this.sql`INSERT INTO workspace_identity (id, name, created_at)
        VALUES (${this.ctx.id.toString()}, ${'unpublished-target'}, ${1_760_000_000_100})`;
      new WorkspaceActorDirectory(this.sql, { workspaceId: this.ctx.id.toString(), ownerUserId: '' }).createMain({ name: 'unpublished-target' });
    }

    this.receiver ??= new ForkTransferReceiver(
      new ForkTargetWriter(this.sql, {
        workspaceId: this.ctx.id.toString(),
        workspaceName: 'fork-target',
        artifactDirectory: PROBE_ARTIFACTS,
        transaction: (rows) => this.ctx.storage.transactionSync(rows),
      }),
      createWorkspaceForkSink(this.fileHost),
    );
    const outcome = await this.receiver.accept(frame);

    if (outcome.status === 'want') return outcome;

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
      identity: identityWithMission(this.sql),
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
      files: await this.files(),
    };
  }
}
