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
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import type { RuntimePackage, RuntimeSource } from '@nimbus-sh/core/runtime/runtime-package.js';
import type { FacetHost } from '@nimbus-sh/core/runtime/facet-host.js';
import type { FabricComposition } from '@nimbus-sh/fabric/composition.js';
import {
  agentIdentity, agentTmpRoot, confineAgentTmp, MAIN_AGENT, provisionAgentHome, restoreAgentTmpConfinements, settleWorkspaceRoot,
  settleWorkspaceSlates, resealWorkspaceSoul,
  type HomeRootVfs, type TmpConfiner,
} from './agent-home';
import { registerNpm, workspaceCommandNotFound } from './workspace-runtimes';
import * as v from 'valibot';
import type { VFS, VfsLinkStat, Shell, ShellExecOptions } from '../types/primitives';
import { WORKSPACE_ROOT, workspacePath } from './workspace-path';
import { diagnostics, KinuError, tolerate, toKinuError } from '../obs/index';
import { atVfsPath } from './errno';
import type { MountedVfs } from './mounts';
import { shellMounts, type ShellMounts, type ShellMountTable } from './shell-mounts';

export { workspaceToolchainCapabilities } from './workspace-runtimes';

export type { RuntimePackage, RuntimeSource } from '@nimbus-sh/core/runtime/runtime-package.js';

export { WORKSPACE_ROOT, workspacePath } from './workspace-path';

export { workspaceBoxFiles } from './workspace-box-files';

const ShellExecOptionsSchema: v.GenericSchema<ShellExecOptions | undefined> = v.optional(v.object({
  stdin: v.optional(v.string()),
  signal: v.optional(v.instance(AbortSignal)),
}));

function shellExecOptions(input: { value: unknown }): ShellExecOptions | undefined {
  const stdin = v.safeParse(v.string(), input.value);

  if (stdin.success) return { stdin: stdin.output };
  const options = v.safeParse(ShellExecOptionsSchema, input.value);

  return options.success ? options.output : undefined;
}

export interface WorkspaceVFS extends VFS {
  lstat(path: string): Promise<VfsLinkStat | null>;
  readlink(path: string): Promise<string>;
  removeRecursive(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Reads only the chunk rows covering the window; for callers that must not hold a whole file. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
}

interface VendorFiles {
  readText(path: string): string | Promise<string>;
  readBytes(path: string): Uint8Array | Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): void | Promise<void>;
  readdir(path: string): readonly { readonly name: string }[] | Promise<readonly { readonly name: string }[]>;
  /** Null when nothing is there; `follow: false` is lstat. */
  stat(path: string, follow: boolean): VendorStat | null | Promise<VendorStat | null>;
  readlink(path: string): string | Promise<string>;
  remove(path: string, recursive: boolean): void | Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): void | Promise<void>;
  exists(path: string): boolean | Promise<boolean>;
  rename(from: string, to: string): void | Promise<void>;
  readRange(path: string, offset: number, length: number): Uint8Array | Promise<Uint8Array>;
}

interface VendorStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly type: string;
}

function workspaceFiles(vendor: VendorFiles): WorkspaceVFS {
  const at = <T>(path: string, syscall: string, call: (absolute: string) => T | Promise<T>): Promise<T> => {
    const absolute = workspacePath(path);

    return atVfsPath(absolute, syscall, () => call(absolute));
  };

  return {
    readFile: (path, opts) => at(path, 'open', (absolute) => opts?.encoding === 'utf8' ? vendor.readText(absolute) : vendor.readBytes(absolute)),
    // Creating a file makes no parents, so the directories come first, as the same credential.
    writeFile: (path, data) => at(path, 'open', async (absolute) => {
      await vendor.mkdir(absolute.slice(0, absolute.lastIndexOf('/')) || '/', { recursive: true });

      return vendor.writeFile(absolute, data);
    }),
    readdir: async (path) => (await at(path, 'scandir', (absolute) => vendor.readdir(absolute))).map((entry) => entry.name),
    async stat(path) {
      const st = await at(path, 'stat', (absolute) => vendor.stat(absolute, true));

      return st === null ? null : { size: st.size, mtimeMs: st.mtimeMs, isDir: st.type === 'directory' };
    },
    async lstat(path) {
      const st = await at(path, 'lstat', (absolute) => vendor.stat(absolute, false));

      return st === null ? null : { size: st.size, mtimeMs: st.mtimeMs, isDir: st.type === 'directory', isSymlink: st.type === 'symlink' };
    },
    readlink: (path) => at(path, 'readlink', (absolute) => vendor.readlink(absolute)),
    unlink: (path) => at(path, 'unlink', (absolute) => vendor.remove(absolute, false)),
    mkdir: (path, opts) => at(path, 'mkdir', (absolute) => vendor.mkdir(absolute, opts)),
    exists: (path) => at(path, 'access', (absolute) => vendor.exists(absolute)),
    removeRecursive: (path) => at(path, 'rm', (absolute) => vendor.remove(absolute, true)),
    rename: (oldPath, newPath) => at(oldPath, 'rename', (absolute) => vendor.rename(absolute, workspacePath(newPath))),
    readRange: (path, offset, length) => at(path, 'read', (absolute) => vendor.readRange(absolute, offset, length)),
  };
}

/** The session user's view, the shell process's own, so every write passes the lease check a command's does. */
function workspaceVfs(open: () => Promise<NimbusWorkspace>): WorkspaceVFS {
  const fs = async (): Promise<NimbusWorkspace['fs']> => (await open()).fs;

  return workspaceFiles({
    readText: async (path) => (await fs()).readFileString(path),
    readBytes: async (path) => (await fs()).readFile(path),
    writeFile: async (path, data) => (await fs()).writeFile(path, data),
    readdir: async (path) => (await fs()).readdir(path),
    stat: async (path, follow) => (await fs()).stat(path, { follow }),
    readlink: async (path) => (await fs()).readlink(path),
    remove: async (path, recursive) => (await fs()).remove(path, { recursive }),
    mkdir: async (path, opts) => (await fs()).mkdir(path, opts),
    exists: async (path) => (await fs()).exists(path),
    rename: async (from, to) => (await fs()).rename(from, to),
    readRange: async (path, offset, length) => (await fs()).readRange(path, offset, length),
  });
}

/** No per-command `cwd`: the shell owns its working directory so `cd` persists. */
function workspaceShell(open: () => Promise<NimbusWorkspace>): Shell {
  return {
    async exec(command, stdinOrOptions) {
      const options = shellExecOptions({ value: stdinOrOptions });

      const workspace = await open();

      const result = await workspace.exec(command, {
        stdin: options?.stdin,
        signal: options?.signal,
      });

      return workspaceCommandNotFound(
        { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
        // Read per call: installs re-register bins mid-session.
        (bin) => workspace.registry.has(bin),
      );
    },
  };
}

/** One agent's credentialed view of the same rows, on both the file and shell planes. */
export interface WorkspaceAgentPlane {
  readonly vfs: WorkspaceVFS;
  readonly shell: Shell;
}

/** As provisioned by `vfs/agent-home.ts`. */
export interface WorkspaceAgent {
  readonly cred: VfsCred;
  readonly home: string;
  readonly tmp: string;
}

/** The same `SqliteVFS`, credentialed as the agent; never the workspace `.fs`, which is pinned to the session user. */
function agentVfs(vfs: CredentialedVfs): WorkspaceVFS {
  return workspaceFiles({
    readText: (path) => vfs.readFileString(path),
    readBytes: (path) => vfs.readFile(path),
    writeFile: (path, data) => vfs.writeFile(path, data),
    readdir: (path) => vfs.readdir(path),
    stat: (path, follow) => {
      const st = tolerate(() => (follow ? vfs.stat(path) : vfs.lstat(path)), 'enoent');

      return st === undefined ? null : { size: st.size, mtimeMs: st.mtime, type: st.type };
    },
    readlink: (path) => vfs.readlink(path),
    remove: (path, recursive) => { if (recursive) vfs.removeRecursive(path); else vfs.unlink(path); },
    mkdir: (path, opts) => vfs.mkdir(path, opts),
    exists: (path) => vfs.exists(path),
    rename: (from, to) => vfs.rename(from, to),
    readRange: (path, offset, length) => vfs.readRange(path, offset, length),
  });
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

export interface WorkspaceBundle {
  vfs: WorkspaceVFS;
  shell: Shell;
  privileged(): Promise<WorkspacePrivileged>;
  /** Cached per uid and idempotent: a shell holds state (`cd`, exports). */
  asAgent(agent: WorkspaceAgent): Promise<WorkspaceAgentPlane>;
  session(): Promise<WorkspaceSession>;
  onFilesChanged(listener: (paths: readonly string[]) => void): () => void;
  /** Shells running as `cred` (default: session user) serve `plane`'s mounts. */
  mountTable(plane: MountedVfs, cred?: Readonly<VfsCred>): () => void;
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
}

/** Returns synchronously; the workspace boots lazily on its first operation. */
export function createWorkspace(opts: WorkspaceOptions): WorkspaceBundle {
  const fileListeners = new Set<(paths: readonly string[]) => void>();
  const mountTables = new Map<number, MountedVfs>();
  const tableFor: ShellMountTable = (cred) => mountTables.get(cred.uid) ?? null;
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

    const workspace = await shellOver(creation);

    shellMountPoints = shellMounts(workspace.filesystem, tableFor);

    for (const plane of mountTables.values()) shellMountPoints.add(plane);
    settleWorkspaceRoot(workspace.vfs.as(CRED_KERNEL));
    // Trusted host init, once per engine boot: a registration is not stored with the tree.
    settleWorkspaceSlates(workspace.vfs.as(CRED_KERNEL), (path) => { workspace.vfs.registerSharedDirectory(path); });
    resealWorkspaceSoul(workspace.vfs.as(CRED_KERNEL), opts.sql);

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
    shell: workspaceShell(open),
    onFilesChanged(listener) {
      fileListeners.add(listener);

      return () => { fileListeners.delete(listener); };
    },
    mountTable(plane, cred) {
      const { uid } = cred ?? CRED_SESSION_USER;
      mountTables.set(uid, plane);
      shellMountPoints?.add(plane);

      return () => { if (mountTables.get(uid) === plane) mountTables.delete(uid); };
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

          // Second shell over the same `SqliteVFS`, never a second filesystem (stale cache).
          // `runAs` is the origin's so `sudo`/`su` keep working.
          const asAgent = await shellOver({
            sql: opts.sql,
            transactions: opts.transactions,
            vfs: origin.vfs,
            cwd: agent.home,
            env: { HOME: agent.home, TMPDIR: agent.tmp },
            identity: {
              pid: process.pid,
              cred: processes.cred(process.pid),
              setUmask: (mask: number) => { processes.setUmask(process.pid, mask); },
              runAs: origin.shell.getRunAsHost(),
            },
            fabric: opts.fabric,
            // The origin's namespace, so this shell serves the same mount points.
            filesystem: origin.filesystem,
          });

          return {
            vfs: agentVfs(origin.vfs.as(agent.cred)),
            shell: workspaceShell(() => Promise.resolve(asAgent)),
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
