/**
 * A workspace's executors as its object serves them: a command run on one, its file plane over each executor's raw
 * handle, the chunked transfers the Files routes make, a terminal's preflight, and the ports a preview lists. The
 * workspace object keeps the methods its callers reach (RPC, `@callable`) and answers each from here.
 */
import { Cause, Effect } from 'effect';
import type { VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
import {
  connectedDevices, deleteExecutorPathOp, ExecutorFileDownload, ExecutorFileUpload, getExecutorFiles, readExecutorFile, renameExecutorPathOp,
  runOnExecutor,
  type ExecutorTextFile, type ExecutorWriteResult, type ExposedPortList, type FilesPage,
} from '@kinu.run/core';
import type { HeldSlatePorts } from '@kinu.run/core/slates';
import { authoredRefusal, diagnostics, renderThrownChain, settle } from '@kinu.run/core/obs';
import type { CFRuntime } from './runtime';
import type { WorkspaceTerminal } from './workspace-host';
import { unownedWorkspace } from './actor-agent';

/** Transfer id is fresh per transfer, so two readers of one path cannot replace
 *  each other's snapshot. */
export interface ExecutorFileChunkRead {
  executorId: string;
  path: string;
  transferId: string;
  offset: number;
  length: number;
}

export interface ExecutorFileChunkWrite {
  executorId: string;
  path: string;
  transferId: string;
  offset: number;
  chunk: Uint8Array;
  final: boolean;
  expectedRevision?: VfsRevision;
}

/** What a command run on an executor left: its output, kept and broadcast as the terminal renders it. */
interface ExecutorOutput {
  readonly stdout: string | null;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface WorkspaceExecutorsHost {
  /** This activation's runtime, read per call. */
  runtime(): Pick<CFRuntime, 'executionRouter' | 'deviceTransport' | 'sandboxHandle'>;
  /** The workspace runtime's terminal, composed on first use. */
  workspaceTerminal(): Promise<WorkspaceTerminal>;
  /** The computer as its last status left it: a refusal it reported, or still restoring. */
  computerState(): { readonly refused: string | null; readonly starting: boolean };
  /** The workspace's ports a slate's application holds, by title, and those an answer's page holds. */
  heldPorts(): Promise<HeldSlatePorts>;
  recordOutput(executorId: string, command: string, output: ExecutorOutput): void;
  broadcast(frame: string): void;
  ownerUserId(): string | null;
  /** A terminal on the owner's machine, opened by the owner's account for this workspace. */
  openOwnerTerminal(window: { cols: number; rows: number }, device: string | undefined): Promise<{ session: string }>;
}

/** A terminal step's refusal as the pane reads it, or null once the step is done. */
function terminalStep(step: Effect.Effect<unknown>, doing: string): Effect.Effect<{ error: string } | null> {
  return Effect.matchCause(step, {
    onSuccess: () => null,
    onFailure: (failed) => ({ error: terminalRefusal({ doing, cause: Cause.squash(failed) }) }),
  });
}

/** A terminal that cannot open: the owner's pane reads the whole chain. */
function terminalRefusal(failure: { doing: string; cause: unknown }): string {
  const error = authoredRefusal({ ...failure });
  diagnostics.failure('terminal.prepare_failed', error);

  return renderThrownChain({ cause: error });
}

export class WorkspaceExecutors {
  // Chunked transfer for files-routes.ts keeps each payload under `do.facet.rpc_bytes`.
  // The actor is single-threaded, so these maps need no lock.
  private readonly uploads = new Map<string, {
    readonly executorId: string;
    readonly path: string;
    readonly expectedRevision: VfsRevision | undefined;
    readonly upload: ExecutorFileUpload;
  }>();

  private readonly downloads = new Map<string, ExecutorFileDownload>();

  constructor(private readonly host: WorkspaceExecutorsHost) {}

  private get router() {
    return this.host.runtime().executionRouter;
  }

  execute(executorId: string, command: string, device?: string) {
    return settle(Effect.gen({ self: this }, function* () {
      const { router } = this;

      if (!router) return { error: 'no execution router' };
      const run = yield* Effect.promise(() => runOnExecutor(router, executorId, command, device));

      if (run.kind === 'refused') return { error: run.error, refusal: run.refusal };

      const output = run.kind === 'ran'
        ? { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, ...(run.refusal && { refusal: run.refusal }) }
        : { stdout: '', stderr: run.error, exitCode: 1, refusal: run.refusal };

      this.host.recordOutput(executorId, command, run.kind === 'ran' ? output : { stdout: null, stderr: run.error, exitCode: 1 });
      // The UI terminal renders only from broadcasts, so a failure is broadcast too.
      this.host.broadcast(JSON.stringify({ type: 'executor-output', executor: executorId, command, ...output, timestamp: Date.now() }));

      return run.kind === 'ran' ? output : { error: run.error, exitCode: 1, refusal: run.refusal };
    }));
  }

  /** A page of the folder from `from`, read off the executor's own raw handle; its answer names where the next starts. */
  async files(executorId: string, path: string, from?: number): Promise<FilesPage> {
    const { router } = this;

    if (!router) return { error: 'no execution router' };

    return getExecutorFiles(router, executorId, path, from);
  }

  async readFile(executorId: string, path: string): Promise<ExecutorTextFile> {
    const { router } = this;

    if (!router) return { error: 'no execution router' };

    return readExecutorFile(router, executorId, path);
  }

  /** Native rename where the plane supports it, byte carry for files elsewhere, refusal for
   * directories that only bytes could carry. Never overwrites. */
  async rename(executorId: string, from: string, to: string): Promise<ExecutorWriteResult> {
    const { router } = this;

    if (!router) return { error: 'no execution router' };

    return renameExecutorPathOp(router, executorId, from, to);
  }

  /** Directories use the plane's native tree removal where it exists, entry by entry elsewhere. */
  async remove(executorId: string, path: string): Promise<ExecutorWriteResult> {
    const { router } = this;

    if (!router) return { error: 'no execution router' };

    return deleteExecutorPathOp(router, executorId, path);
  }

  async startDownload(
    executorId: string,
    path: string,
    transferId: string,
  ): Promise<
    { size: number }
    | { error: string; reason: 'too_large' | 'unavailable' }
  > {
    const { router } = this;

    if (!router) return { error: 'no execution router', reason: 'unavailable' };

    if (!transferId) return { error: 'download transfer id required', reason: 'unavailable' };
    const download = new ExecutorFileDownload(router, executorId, path);
    this.downloads.set(transferId, download);
    const opened = await download.open();

    if ('error' in opened) this.downloads.delete(transferId);

    return opened;
  }

  /** The route supplies a fresh transfer id per GET, so readers never share or reuse stale bytes. */
  async readChunk(read: ExecutorFileChunkRead): Promise<{ bytes: Uint8Array } | { error: string }> {
    const { executorId, path, transferId, offset, length } = read;

    if (!this.router) return { error: 'no execution router' };

    if (!transferId) return { error: 'download transfer id required' };
    const download = this.downloads.get(transferId);

    if (!download || !download.serves(executorId, path)) {
      return { error: 'file transfer out of sync: no matching open download' };
    }

    const result = await download.range(offset, length);

    if ('error' in result || download.completeAfter(offset + result.bytes.byteLength)) {
      this.downloads.delete(transferId);
    }

    return result;
  }

  abortDownload(transferId: string): void {
    this.downloads.delete(transferId);
  }

  /** An `offset === 0` chunk (re)starts the transfer so retries self-heal; ordering and
   * continuity are enforced inside the transfer, not trusted from the caller. */
  async writeChunk(write: ExecutorFileChunkWrite): Promise<ExecutorWriteResult> {
    const { executorId, path, transferId, offset, chunk, final, expectedRevision } = write;
    const { router } = this;

    if (!router) return { error: 'no execution router' };

    if (!path) return { error: 'file path required' };

    if (!transferId) return { error: 'upload transfer id required' };
    let row = this.uploads.get(transferId);

    if (offset === 0) {
      row = {
        executorId,
        path,
        expectedRevision,
        upload: new ExecutorFileUpload(router, executorId, path, { expectedRevision }),
      };
      this.uploads.set(transferId, row);
    } else if (!row || row.executorId !== executorId || row.path !== path) {
      return { error: 'file transfer out of sync: no matching open upload' };
    } else if (row.expectedRevision !== expectedRevision) {
      return { error: 'file transfer out of sync: expected revision does not match the first chunk' };
    }

    const result = await row.upload.chunk(offset, chunk, final);

    if (row.upload.done) this.uploads.delete(transferId);

    return result;
  }

  abortWrite(transferId: string): void {
    this.uploads.get(transferId)?.upload.abort();
    this.uploads.delete(transferId);
  }

  /** Terminal preflight via the sandbox lane's own `ensureReady` (egress grants, /workspace). */
  prepareTerminal(executorId: string): Promise<{ ok: true } | { error: string }> {
    return settle(Effect.gen({ self: this }, function* () {
      // The owner's machine has no container to warm; it only needs to be attached.
      if (executorId === 'device') {
        const { devices } = this.host.runtime().deviceTransport.status();

        if (connectedDevices(devices).length > 0) return { ok: true };

        if ((devices?.length ?? 0) > 0) return { error: 'That machine is offline. Run `kinu connect` on it.' };

        return { error: 'No machine is linked to this account yet. Run `kinu connect` on the one you want.' };
      }

      if (executorId === 'workspace') {
        return (yield* terminalStep(Effect.promise(async () => this.host.workspaceTerminal()), 'composing the workspace runtime for a terminal')) ?? { ok: true };
      }

      if (executorId !== 'computer') return { error: `${executorId} has no terminal` };
      const handle = this.host.runtime().sandboxHandle;

      if (!handle) return { error: 'this workspace has no computer configured' };

      return (yield* terminalStep(Effect.promise(() => handle.ensureReady()), 'preparing the computer for a terminal')) ?? { ok: true };
    }));
  }

  /** `user` is the object holding both sockets; the route sends the pane's upgrade there. */
  openDeviceTerminal(window: { cols: number; rows: number }, device?: string): Promise<{ session: string; user: string } | { error: string }> {
    return settle(Effect.suspend((): Effect.Effect<{ session: string; user: string } | { error: string }> => {
      const user = this.host.ownerUserId();

      if (!user) return Effect.succeed({ error: unownedWorkspace().message });

      // Each refusal the user object authors (no device, an older daemon, consent) reaches the pane as written.
      return Effect.matchCause(Effect.promise(async () => this.host.openOwnerTerminal(window, device)), {
        onSuccess: (opened) => ({ session: opened.session, user }),
        onFailure: (failed) => ({ error: terminalRefusal({ doing: 'opening a terminal on this machine', cause: Cause.squash(failed) }) }),
      });
    }));
  }

  /** Workspace port registrations live in Nimbus, so they stay authoritative after a restart. */
  async exposedPorts(executorId: string): Promise<ExposedPortList> {
    const computer = executorId === 'computer' ? this.host.computerState() : null;

    if (computer?.refused != null) return { ports: [], error: computer.refused };

    if (computer?.starting === true) return { ports: [], pending: "the computer is still restoring" };

    const provider = this.router?.getProvider(executorId);

    if (!provider) {
      return executorId === 'computer'
        ? { ports: [] }
        : { ports: [], error: `${executorId} preview provider is unavailable` };
    }

    const status = provider.getStatus?.();

    if (status && !status.active && provider.kind !== 'workspace') {
      return { ports: [] };
    }

    if (!provider.listExposedPorts) {
      return { ports: [], error: `${executorId} cannot list exposed ports` };
    }

    const listing = provider.listExposedPorts;
    // A port a slate's application holds is called by the slate's title, never by its number; an answer's page is the
    // chat's until it is saved.
    const held = executorId === 'workspace' ? this.host.heldPorts() : Promise.resolve(null);

    return settle(Effect.matchCause(Effect.promise(async () => Promise.all([listing.call(provider), held])), {
      onSuccess: ([ports, slates]) => ({
        ports: ports.filter(({ port }) => slates?.pages.has(port) !== true).map(({ port, name, url }) => ({ port, url, name: name ?? slates?.titles.get(port) })),
      }),
      onFailure: (failed) => {
        const error = Cause.squash(failed);

        return {
          ports: [],
          error: error instanceof Error && error.message
            ? error.message
            : `Couldn't list ${executorId} preview ports`,
        };
      },
    }));
  }
}
