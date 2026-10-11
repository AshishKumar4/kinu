import type { Awaitable, VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * The Nimbus workspace: one durable POSIX filesystem plus shell over the host's SQLite,
 * sharing its transactions. `vfs` and `shell` address the same paths.
 */

// Type-only: the value import stays inside the lazy boot so Nimbus's wasm graph is not
// loaded at module eval (cold start; workerd test pool cannot load it).
import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PID_GEN_STRIDE } from '@nimbus-sh/core/runtime/process-table.js';
import type { SqlDatabase, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { assumeGeneration, generation } from '@nimbus-sh/fabric/generation.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { sqliteFiles, type SqliteFiles } from '@nimbus-sh/core/vfs/sqlite-files.js';
import type { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import type { RuntimePackage, RuntimeSource } from '@nimbus-sh/core/runtime/runtime-package.js';
import type { FacetHost } from '@nimbus-sh/core/runtime/facet-host.js';
import type { FabricComposition } from '@nimbus-sh/fabric/composition.js';
import type { CommandResult, RunOptions } from '@nimbus-sh/core/substrate/lifo/sandbox/run-command.js';
import {
  agentIdentity, agentTmpRoot, confineAgentTmp, MAIN_AGENT, provisionAgentHome, restoreAgentTmpConfinements, settleWorkspaceRoot,
  settleWorkspaceSlates, provisionWorkspaceSoul,
  type HomeRootVfs, type TmpConfiner,
} from './agent-home';
import { registerNpm, workspaceCommandNotFound } from './workspace-runtimes';
import * as v from 'valibot';
import { ShellExecOptionsSchema, type Shell, type ShellExecOptions } from '../types/primitives';
import { WORKSPACE_ROOT, workspacePath } from './workspace-path';
import { FORK_PIN_PREFIX } from '../identity/fork';
import { ARCHIVE_PIN_PREFIX } from '../identity/archive';
import { diagnostics, KinuError, toKinuError } from '../obs/index';
import { atVfsPath } from './errno';
import type { VfsMount, WorkspacePrincipal } from './mounts';
import type { CompositeVFS } from '@nimbus-sh/core/vfs/composite.js';
import { shellMounts, type ShellMounts, type ShellMountTable } from './shell-mounts';


export type { RuntimePackage, RuntimeSource } from '@nimbus-sh/core/runtime/runtime-package.js';

export { WORKSPACE_ROOT, workspacePath } from './workspace-path';

function shellExecOptions(input: { value: unknown }): ShellExecOptions | undefined {
  const stdin = v.safeParse(v.string(), input.value);

  if (stdin.success) return { stdin: stdin.output };
  const options = v.safeParse(ShellExecOptionsSchema, input.value);

  return options.success ? options.output : undefined;
}

/** `open`'s files with relative paths from `cwd`; a write makes its parent directories first, as the same credential. */
function workspaceFiles(open: () => Promise<WorkspaceFiles>, cwd: string): WorkspaceFiles {
  const at = <T>(path: string, syscall: string, call: (files: WorkspaceFiles, absolute: string) => Awaitable<T>): Promise<T> => {
    const absolute = workspacePath(path, cwd);

    return atVfsPath(absolute, syscall, async () => call(await open(), absolute));
  };

  return {
    readFile: (path) => at(path, 'open', (files, absolute) => files.readFile(absolute)),
    writeFile: (path, data) => at(path, 'open', async (files, absolute) => {
      await files.mkdir(absolute.slice(0, absolute.lastIndexOf('/')) || '/', { recursive: true });

      return files.writeFile(absolute, data);
    }),
    readdir: (path) => at(path, 'scandir', (files, absolute) => files.readdir(absolute)),
    stat: (path, options) => at(path, options?.follow === false ? 'lstat' : 'stat', (files, absolute) => files.stat(absolute, options)),
    readlink: (path) => at(path, 'readlink', (files, absolute) => files.readlink(absolute)),
    unlink: (path) => at(path, 'unlink', (files, absolute) => files.unlink(absolute)),
    mkdir: (path, opts) => at(path, 'mkdir', (files, absolute) => files.mkdir(absolute, opts)),
    removeRecursive: (path) => at(path, 'rm', (files, absolute) => files.removeRecursive(absolute)),
    rename: (oldPath, newPath) => at(oldPath, 'rename', (files, absolute) => files.rename(absolute, workspacePath(newPath, cwd))),
    readRange: (path, offset, length) => at(path, 'read', (files, absolute) => files.readRange(absolute, offset, length)),
  };
}

/** The session user's view, the shell process's own, so every write passes the lease check a command's does. */
function workspaceVfs(open: () => Promise<NimbusWorkspace>): WorkspaceFiles {
  return workspaceFiles(async () => (await open()).fs, WORKSPACE_ROOT);
}

type ShellCall = (workspace: NimbusWorkspace, command: string, options: RunOptions & { readonly cwd: string }) => Promise<CommandResult>;

/** Where a call starts: a directory, and a relative `cwd` taken from it. */
type CallStart = Pick<NimbusWorkspace['fs'], 'cwd' | 'resolve'>;

/** Each call is a shell of its own, started at its `cwd` or `start`'s directory; nothing it changes lasts. */
function workspaceShell(open: () => Promise<NimbusWorkspace>, start: (workspace: NimbusWorkspace) => CallStart, run: ShellCall): Shell {
  return {
    async exec(command, stdinOrOptions) {
      const options = shellExecOptions({ value: stdinOrOptions });

      if (options?.name !== undefined) {
        const refusal = { reason: 'unsupported' as const, error: 'this workspace keeps no named shells; run the command without a name' };

        return { stdout: '', stderr: refusal.error, exitCode: 1, refusal };
      }

      const workspace = await open();
      const at = start(workspace);
      const cwd = options?.cwd === undefined ? at.cwd : at.resolve(options.cwd);
      const output = options?.output;

      const result = await run(workspace, command, {
        cwd,
        stdin: options?.stdin,
        signal: options?.signal,
        ...(output !== undefined && {
          onStdout: (data: Uint8Array) => { output.write('stdout', data); },
          onStderr: (data: Uint8Array) => { output.write('stderr', data); },
        }),
      });

      return workspaceCommandNotFound(
        { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, cwd },
        // Read per call: installs re-register bins mid-session.
        (bin) => workspace.registry.has(bin),
      );
    },
  };
}

/** Nimbus's one-shot exec runs as the session user; an agent's call runs as the agent's own process, in a shell built for it. */
function agentCall(pid: number, env: Readonly<Record<string, string>>): ShellCall {
  return async (workspace, command, options) => {
    const { runCommand } = await import('@nimbus-sh/core/substrate/lifo/sandbox/run-command.js');
    const shell = workspace.shellFor(pid, { cwd: options.cwd, env });

    try {
      return await runCommand(shell, command, { ...options, cwd: undefined });
    } finally {
      await shell.closeDescriptors();
    }
  };
}

/** One agent's credentialed view of the same rows, on both the file and shell planes. */
export interface WorkspaceAgentPlane {
  readonly vfs: WorkspaceFiles;
  readonly shell: Shell;
}

/** As provisioned by `vfs/agent-home.ts`. */
export interface WorkspaceAgent {
  readonly cred: VfsCred;
  readonly home: string;
  readonly tmp: string;
}

/**
 * The store as `cred` (default the session user) sees it, with no mount, relative paths from `home`: an actor's own state.
 * Nimbus's own SqliteFiles, never the workspace `.fs`, which is pinned to the session user; its stat carries the row's
 * revision and inode.
 */
export function storeFiles(open: () => Promise<SqliteVFS>, plane: { readonly home: string; readonly cred?: VfsCred }): WorkspaceFiles {
  let files: SqliteFiles | undefined;

  return workspaceFiles(async () => files ??= sqliteFiles(await open(), plane.cred ?? CRED_SESSION_USER), plane.home);
}

/** Uid-0 view of the same bytes plus the principal registry that scopes `/tmp` per uid. */
export interface WorkspacePrivileged {
  /** Only uid 0 can `chown` to another uid, which is why provisioning is host-side. */
  readonly root: HomeRootVfs;
  readonly confiner: TmpConfiner;
}

type NimbusCreation = Parameters<typeof NimbusWorkspace.create>[0];

export type SupervisorOpResult = Awaited<ReturnType<NimbusWorkspace['supervisorOp']>>;

/** This workspace's Nimbus primitives for a host's process/port surface; reuse them, never open a second workspace over the same database. */
export interface WorkspaceSession {
  readonly workspace: NimbusWorkspace;
  readonly shell: NimbusWorkspace['shell'];
  readonly vfs: SqliteVFS;
  /** The namespace and process bindings over `vfs`: mounts, process views, the synchronous `namespaceFs`. */
  readonly filesystem: ProcessFiles;
  readonly registry: NimbusWorkspace['registry'];
  /** The only process owner; a host spawning through its own would issue pids at or below the revoked generation floor. */
  readonly processes: SessionProcessSupervisor;
  /** Hosts must forward their mounted facet method here, or `git clone`/`npm install` refuse. */
  readonly supervisorOp: (envelope: SupervisorOpEnvelope) => Promise<SupervisorOpResult>;
  readonly sql: SqlDatabase;
}

function principalKey(cred: Readonly<VfsCred>, actor: string | undefined): string {
  return `${cred.uid}@${actor ?? ''}`;
}

/** A file plane that answers every call a workspace's own tree can: ranged reads, links, renames, recursive removal. */
export type WorkspaceFiles = VFS & Required<Pick<VFS, 'readRange' | 'readlink' | 'rename' | 'removeRecursive'>>;

export interface WorkspaceBundle {
  vfs: WorkspaceFiles;
  shell: Shell;
  privileged(): Promise<WorkspacePrivileged>;
  /** Cached per uid and idempotent: a shell holds state (`cd`, exports). */
  asAgent(agent: WorkspaceAgent): Promise<WorkspaceAgentPlane>;
  session(): Promise<WorkspaceSession>;
  onFilesChanged(listener: (paths: readonly string[]) => void): () => void;
  /** `principal`'s view (default: the session user) holds `mounts`. */
  mountTable(mounts: readonly VfsMount[], principal?: WorkspacePrincipal): () => void;
  namespace(principal?: WorkspacePrincipal): Promise<CompositeVFS>;
  /** Drops only the workspace tables; the host's own rows stay. */
  destroy(): Promise<void>;
}

export interface WorkspaceOptions {
  /** In a Durable Object: `ctx.storage.sql`. */
  sql: SqlDatabase;
  /** Carries `transactionSync`; in a Durable Object, `ctx`. Must be a real transaction. */
  transactions: { readonly storage?: { readonly transactionSync: <T>(cb: () => T) => T } };
  /**
   * Process-id generation storage; must never repeat a value, since boot revokes append capabilities
   * at or below `generation * 1_000_000`. See {@link workspaceGenerationStorage}.
   */
  generation: WorkspaceGeneration;
  /** Runtime packages the host can install; supplied by the host because they read `node:fs`. */
  runtimes?: readonly RuntimePackage[];
  /** Absent on workerd, where no wasm interpreter can run. */
  runtimeFacets?: FacetHost;
  /** Embedder fabric for hosts that can run dynamic workers; the CLI passes none. */
  fabric?: FabricComposition;
  /** Remote runtime catalog (e.g. R2); names it can satisfy become install-on-first-use stubs. */
  runtimeSource?: RuntimeSource;
  /**
   * Where every request and socket the workspace's commands and programs make goes out (`NimbusWorkspaceOptions.egress`),
   * asked once as the workspace opens, without waiting on anything. Absent, or answering none, they use the isolate's
   * own network.
   */
  egress?: () => NimbusCreation['egress'];
}

/** Returns synchronously; the workspace boots lazily on its first operation. */
export function createWorkspace(opts: WorkspaceOptions): WorkspaceBundle {
  const fileListeners = new Set<(paths: readonly string[]) => void>();
  const mountTables = new Map<string, readonly VfsMount[]>();
  const tableFor: ShellMountTable = (principal) => (principal.cred === null ? null : mountTables.get(principalKey(principal.cred, principal.actor)) ?? null);
  let shellMountPoints: ShellMounts | undefined;
  let booting: Promise<NimbusWorkspace> | undefined;

  const shellOver = async (creation: NimbusCreation): Promise<NimbusWorkspace> => {
    const { NimbusWorkspace } = await import('@nimbus-sh/core/workspace');

    return await NimbusWorkspace.create(creation);
  };

  const boot = async (): Promise<NimbusWorkspace> => {
    // Boot revokes append writers at or below `generation * PID_GEN_STRIDE`, so the pid base must be
    // this generation.
    const generationNow = takeWorkspaceGeneration(opts);

    processes.setPidBase(generationNow * PID_GEN_STRIDE);

    let creation: NimbusCreation = {
      sql: opts.sql,
      transactions: opts.transactions,
      generation: generationNow,
      cwd: WORKSPACE_ROOT,
      env: { HOME: WORKSPACE_ROOT, TMPDIR: agentTmpRoot(MAIN_AGENT) },
      processes,
      fabric: opts.fabric,
      // Each supplied runtime's bins are stubs that install it on first use; a reopened workspace rehydrates it.
      runtimes: opts.runtimes ?? [],
      runtimeInstall: 'on-demand',
    };

    if (opts.runtimeFacets !== undefined) creation = { ...creation, facets: opts.runtimeFacets };

    if (opts.runtimeSource !== undefined) creation = { ...creation, runtimeSource: opts.runtimeSource };

    const egress = opts.egress?.();

    if (egress !== undefined) creation = { ...creation, egress };

    const workspace = await shellOver(creation);

    // A transfer pin lives for its activation: a restart ends the forks and exports it served.
    for (const pin of workspace.vfs.snapshots()) {
      if (pin.name.startsWith(FORK_PIN_PREFIX) || pin.name.startsWith(ARCHIVE_PIN_PREFIX)) await workspace.vfs.dropSnapshotAsync(pin.name);
    }

    shellMountPoints = shellMounts(workspace.filesystem, tableFor);

    for (const mounts of mountTables.values()) shellMountPoints.add(mounts);
    settleWorkspaceRoot(workspace.vfs.as(CRED_KERNEL));
    // Trusted host init, once per engine boot: a registration is not stored with the tree.
    settleWorkspaceSlates(workspace.vfs.as(CRED_KERNEL), (path) => { workspace.vfs.registerSharedDirectory(path); });
    provisionWorkspaceSoul(workspace.vfs.as(CRED_KERNEL));

    await registerNpm(workspace);
    const root = workspace.vfs.as(CRED_KERNEL);
    const main = agentIdentity(opts.sql, MAIN_AGENT);
    provisionAgentHome(root, MAIN_AGENT, main);
    confineAgentTmp(workspace.vfs, MAIN_AGENT, main);
    restoreAgentTmpConfinements(opts.sql, root, workspace.vfs);
    workspace.vfs.events.on((batch) => {
      if (fileListeners.size === 0) return;
      // A rename names where the file left as well as where it went.
      const paths = batch.flatMap((event) => (event.oldPath === undefined ? [event.path] : [event.path, event.oldPath]));

      for (const listener of fileListeners) listener(paths);
    });

    return workspace;
  };

  const open = async (): Promise<NimbusWorkspace> => {
    const attempt = (booting ??= boot());

    try {
      return await attempt;
    } catch (cause) {
      // The first waiter to see this attempt fail clears it, so the next call boots afresh instead of
      // re-awaiting a cached rejection for the isolate's life; a newer attempt stays cached.
      if (booting === attempt) {
        booting = undefined;
        diagnostics.failure(
          'workspace.boot_failed',
          toKinuError({ doing: 'boot the Nimbus workspace', cause, otherwise: 'unavailable' }),
        );
      }

      throw cause;
    }
  };

  // One supervisor for this filesystem so no two shells share a pid; `open` sets its pid base.
  const processes = new SessionProcessSupervisor();

  const planes = new Map<number, Promise<WorkspaceAgentPlane>>();

  return {
    vfs: workspaceVfs(open),
    shell: workspaceShell(open, (workspace) => workspace.fs, (workspace, command, options) => workspace.exec(command, options)),
    onFilesChanged(listener) {
      fileListeners.add(listener);

      return () => { fileListeners.delete(listener); };
    },
    mountTable(mounts, principal) {
      const key = principalKey(principal?.cred ?? CRED_SESSION_USER, principal?.actor);
      mountTables.set(key, mounts);
      shellMountPoints?.add(mounts);

      return () => { if (mountTables.get(key) === mounts) mountTables.delete(key); };
    },
    async namespace(principal) {
      return (await open()).filesystem.vfs.as(principal?.cred ?? CRED_SESSION_USER, principal?.actor);
    },
    async privileged() {
      const workspace = await open();

      return { root: workspace.vfs.as(CRED_KERNEL), confiner: workspace.vfs };
    },
    async session() {
      const workspace = await open();

      return {
        workspace,
        shell: workspace.shell,
        vfs: workspace.vfs,
        filesystem: workspace.filesystem,
        registry: workspace.registry,
        processes,
        sql: opts.sql,
        // Bound to the origin workspace, where the dispatch table was built.
        supervisorOp: (envelope: SupervisorOpEnvelope) => workspace.supervisorOp(envelope),
      };
    },
    async destroy() { (await open()).destroy(); },
    async asAgent(agent) {
      const held = planes.get(agent.cred.uid);

      if (held) return await held;

      const opening = (async (): Promise<WorkspaceAgentPlane> => {
        try {
          const origin = await open();
          const process = processes.spawn('agent', [agent.home], agent.home, { cred: agent.cred });
          // Over the origin's files, commands and mount table; a second workspace would seed its HOME as the session user.
          const home: CallStart = { cwd: agent.home, resolve: (path) => workspacePath(path, agent.home) };

          return {
            vfs: storeFiles(() => Promise.resolve(origin.vfs), agent),
            shell: workspaceShell(() => Promise.resolve(origin), () => home, agentCall(process.pid, { HOME: agent.home, TMPDIR: agent.tmp })),
          };
        } catch (cause) {
          // Same rule as `booting`: never cache a rejection.
          planes.delete(agent.cred.uid);
          throw cause;
        }
      })();

      planes.set(agent.cred.uid, opening);

      return await opening;
    },
  };
}

const GENERATION_TABLE = 'kinu_workspace_generation';

/** One past the persisted generation, in one write transaction (ADR W1). */
function takeWorkspaceGeneration(opts: Pick<WorkspaceOptions, 'sql' | 'transactions' | 'generation'>): number {
  const adopted = generation(opts.generation);

  if (adopted !== 0) return adopted;
  const transactions = opts.transactions.storage;

  if (transactions === undefined) throw new KinuError('unsupported', 'a workspace takes its generation in a transaction, and this host has none');

  const next = transactions.transactionSync(() => {
    opts.sql.exec(`INSERT INTO ${GENERATION_TABLE} (id, value) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1`);

    return v.parse(v.pipe(v.number(), v.integer(), v.minValue(1)), Number([...opts.sql.exec(`SELECT value FROM ${GENERATION_TABLE} WHERE id = 1`)][0]?.value));
  });

  assumeGeneration(opts.generation, next);

  return next;
}

export interface WorkspaceGeneration {
  readonly table: typeof GENERATION_TABLE;
}

/** The generation counter as a single SQLite row, so it survives eviction and restarts. */
export function workspaceGenerationStorage(sql: SqlDatabase): WorkspaceGeneration {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${GENERATION_TABLE} (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`);

  return { table: GENERATION_TABLE };
}
