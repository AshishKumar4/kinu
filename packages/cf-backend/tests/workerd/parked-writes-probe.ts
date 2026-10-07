import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * An overwrite of the user's file parked on the owner and approved, on real Durable Object storage. Its bytes go
 * through Nimbus's own writeFile, which stages a large file in bounded transactions; one synchronous turn holding
 * them all is what resets an object, and only the platform does that.
 */
import { DurableObject } from 'cloudflare:workers';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { cloudPlanes, DeferredApprovalQueue, DeferredApprovalStore, WORKSPACE_ROOT, initDeferredApprovalsTable, initWorkspaceSchema, ParkedWriteFiles, performBoundWrite, sha256Hex, withApprovalGatedFiles, WorkspaceActorDirectory, type SqlExec, type SqlExecutor, type SqlValue } from '@kinu.run/core';

/** The owner's machine as the agent's plane mounts it. */
const MACHINE = '/pc/studio';

const NOTES = `${MACHINE}/notes.bin`;

export interface ParkedWriteReport {
  /** New per instance of the object: a reset one answers with another. */
  readonly incarnation: string;
  readonly error: string | null;
  readonly queued: readonly string[];
  readonly fileSha: string;
  readonly parkedFiles: number;
}

/** A byte pattern of `size`, distinct per `seed`. */
function pattern(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) bytes[index] = ((index * 31) + seed) % 251;

  return bytes;
}

/** The file plane as the agent's tools reach it, over the kernel's view of this object's workspace. */
function planeOver(files: CredentialedVfs): VFS {
  return {
    readFile: async (path) => files.readFileUncached(path),
    writeFile: async (path, data) => { files.writeFile(path, data); },
    readdir: async (path) => files.readdir(path),
    stat: async (path) => {
      if (!files.exists(path)) return null;
      const stat = files.lstat(path);

      return { size: stat.size, mtimeMs: stat.mtime, type: stat.type };
    },
    unlink: async (path) => { files.unlink(path); },
    mkdir: async (path, opts) => { files.mkdir(path, opts); },
  };
}

export class ParkedWritesProbeDO extends DurableObject<Cloudflare.Env> {
  private readonly incarnation = crypto.randomUUID();

  private readonly sql: SqlExecutor = <Row,>(
    query: TemplateStringsArray, ...values: SqlValue[]
  ): Row[] => this.ctx.storage.sql.exec<Row & Record<string, SqlStorageValue>>(query.join('?'), ...values).toArray();

  private readonly exec: SqlExec = { exec: (query, ...bindings) => this.ctx.storage.sql.exec(query, ...bindings) };

  private opened: Promise<{ readonly queue: DeferredApprovalQueue; readonly plane: VFS; readonly kernel: CredentialedVfs }> | undefined;

  private open() {
    this.opened ??= (async () => {
      const execRaw = (ddl: string): void => { this.ctx.storage.sql.exec(ddl); };

      initWorkspaceSchema({ execRaw, sql: this.sql, exec: this.exec, transactionSync: (write) => this.ctx.storage.transactionSync(write) });
      initDeferredApprovalsTable(execRaw);
      void this.sql`INSERT OR IGNORE INTO workspace_identity (id, name) VALUES (${'ws-parked-writes'}, ${'parked-writes'})`;
      const actor = new WorkspaceActorDirectory(this.sql, { workspaceId: 'ws-parked-writes', ownerUserId: '' }).createMain({ name: 'parked-writes' });
      const workspace = await NimbusWorkspace.create({ sql: this.ctx.storage.sql, transactions: { storage: this.ctx.storage } });
      const kernel = workspace.vfs.as(CRED_KERNEL);
      const plane = planeOver(kernel);

      const queue = new DeferredApprovalQueue({
        store: new DeferredApprovalStore(this.sql, actor), remember: () => {},
        inbox: { send: async () => 'queued' },
        writes: {
          content: new ParkedWriteFiles(async () => kernel),
          perform: (write, bytes) => performBoundWrite(plane, write, bytes),
        },
      });

      return { queue, plane, kernel };
    })();

    return this.opened;
  }

  private async report(error: string | null): Promise<ParkedWriteReport> {
    const { queue, kernel } = await this.open();
    const parked = kernel.readdir('/etc').filter((entry) => entry.name.includes('parked'));

    return {
      incarnation: this.incarnation, error, queued: queue.list().map((row) => row.id),
      fileSha: sha256Hex(kernel.readFileUncached(NOTES)),
      parkedFiles: parked.reduce((files, entry) => files + kernel.readdir(`/etc/${entry.name}`).length, 0),
    };
  }

  /** The owner's `size`-byte file, then the agent's gated overwrite of it with nobody there to answer. */
  async park(size: number): Promise<ParkedWriteReport & { readonly askedSha: string }> {
    const { queue, plane, kernel } = await this.open();
    kernel.mkdir(MACHINE, { recursive: true });
    await plane.writeFile(NOTES, pattern(size, 1));

    const asked = pattern(size, 2);

    const files = withApprovalGatedFiles(plane, 'workspace', { planes: cloudPlanes(WORKSPACE_ROOT), resolve: null, userRoots: () => ['/pc'], locate: null, parksWrites: true }, {
      mode: () => 'strict', deferrals: queue.channel,
    });

    let error: string | null = null;

    try {
      await files.writeFile(NOTES, asked);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    return { ...await this.report(error), askedSha: sha256Hex(asked) };
  }

  async approve(): Promise<ParkedWriteReport> {
    const { queue } = await this.open();
    await queue.decide(queue.list().map((row) => row.id), 'approved');

    return await this.report(null);
  }
}
