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
import { adoptGeneration, GENERATION_KEY, generation, type GenerationContext } from '@nimbus-sh/fabric/generation.js';
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { RuntimePackage, RuntimeSource } from '@nimbus-sh/core/runtime/runtime-package.js';
import type { FacetHost } from '@nimbus-sh/core/runtime/facet-host.js';
import type { FabricComposition } from '@nimbus-sh/fabric/composition.js';
import { agentIdentity, agentTmpRoot, confineAgentTmp, MAIN_AGENT, provisionAgentHome, restoreAgentTmpConfinements, type HomeRootVfs, type TmpConfiner } from './agent-home';
import { provisionWorkspaceRuntimes, workspaceCommandNotFound } from './workspace-runtimes';
import * as v from 'valibot';
import type { VFS, Shell, ShellExecOptions } from '../types/primitives';
import { WORKSPACE_ROOT, workspacePath } from './workspace-path';
import { diagnostics, KinuError, toKinuError } from '../obs/index';
import { isVfsError } from './errno';
import type { MountedVfs } from './mounts';
import { mountedAuthority, type ShellMountTable } from './shell-mounts';

export { workspaceToolchainCapabilities } from './workspace-runtimes';

export type { RuntimePackage, RuntimeSource } from '@nimbus-sh/core/runtime/runtime-package.js';

export { WORKSPACE_ROOT, workspacePath } from './workspace-path';

const ShellExecOptionsSchema: v.GenericSchema<ShellExecOptions | undefined> = v.optional(v.object({
  stdin: v.optional(v.string()),
  signal: v.optional(v.instance(AbortSignal)),
}));

/** Nimbus reports a missing path as ENOENT; the VFS contract maps it to `null`/`false`. */
function isEnoent({ error }: { error: unknown }): boolean {
  if (isVfsError(error)) return error.code === 'ENOENT';

  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;

  return false;
}

function shellExecOptions(input: { value: unknown }): ShellExecOptions | undefined {
  const stdin = v.safeParse(v.string(), input.value);

  if (stdin.success) return { stdin: stdin.output };
  const options = v.safeParse(ShellExecOptionsSchema, input.value);

  return options.success ? options.output : undefined;
}

export interface WorkspaceVFS extends VFS {
  removeRecursive(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Reads only the chunk rows covering the window; for callers that must not hold a whole file. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
}

function workspaceVfs(open: () => Promise<NimbusWorkspace>): WorkspaceVFS {
  const fs = async (): Promise<NimbusWorkspace['fs']> => (await open()).fs;

  const self: WorkspaceVFS = {
    async readFile(path, opts) {
      const abs = workspacePath(path);

      return opts?.encoding === 'utf8' ? (await fs()).readFile(abs) : (await fs()).readFile(abs, null);
    },
    async writeFile(path, data) { await (await fs()).writeFile(workspacePath(path), data); },
    async readdir(path) { return (await (await fs()).readdir(workspacePath(path))).map((entry) => entry.name); },
    async stat(path) {
      try {
        const st = await (await fs()).stat(workspacePath(path));

        return { size: st.size, mtimeMs: st.mtime, isDir: st.type === 'directory' };
      } catch (err) {
        if (isEnoent({ error: err })) return null;
        throw err;
      }
    },
    async unlink(path) { await (await fs()).rm(workspacePath(path)); },
    async mkdir(path, opts) { await (await fs()).mkdir(workspacePath(path), opts); },
    async exists(path) { return (await fs()).exists(workspacePath(path)); },

    async removeRecursive(path) { await (await fs()).rm(workspacePath(path), { recursive: true }); },

    async rename(oldPath, newPath) {
      await (await fs()).rename(workspacePath(oldPath), workspacePath(newPath));
    },

    async readRange(path, offset, length) {
      return (await open()).vfs.as(CRED_SESSION_USER).readRange(workspacePath(path), offset, length);
    },
  };

  return self;
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
  const self: WorkspaceVFS = {
    async readFile(path, opts) {
      const absolute = workspacePath(path);

      return opts?.encoding === 'utf8' ? vfs.readFileString(absolute) : vfs.readFile(absolute);
    },
    async writeFile(path, data) { vfs.writeFile(workspacePath(path), data); },
    async readdir(path) { return vfs.readdir(workspacePath(path)).map((entry) => entry.name); },
    async stat(path) {
      try {
        const stat = vfs.stat(workspacePath(path));

        return { size: stat.size, mtimeMs: stat.mtime, isDir: stat.type === 'directory' };
      } catch (error) {
        if (isEnoent({ error })) return null;
        throw error;
      }
    },
    async unlink(path) { vfs.unlink(workspacePath(path)); },
    async mkdir(path, opts) { vfs.mkdir(workspacePath(path), opts); },
    async exists(path) { return vfs.exists(workspacePath(path)); },
    async removeRecursive(path) { vfs.removeRecursive(workspacePath(path)); },
    async rename(oldPath, newPath) { vfs.rename(workspacePath(oldPath), workspacePath(newPath)); },
    async readRange(path, offset, length) { return vfs.readRange(workspacePath(path), offset, length); },
  };

  return self;
}

/** Uid-0 view of the same bytes plus the principal registry that scopes `/tmp` per uid. */
export interface WorkspacePrivileged {
  /** Only uid 0 can `chown` to another uid, which is why provisioning is host-side. */
  readonly root: HomeRootVfs;
  readonly confiner: TmpConfiner;
}

export type SupervisorOpResult = Awaited<ReturnType<NimbusWorkspace['supervisorOp']>>;

/** This workspace's Nimbus primitives for a host's process/port surface; reuse them, never open a second workspace over the same database. */
export interface WorkspaceSession {
  readonly workspace: NimbusWorkspace;
  readonly shell: NimbusWorkspace['shell'];
  readonly vfs: SqliteVFS;
  readonly registry: NimbusWorkspace['registry'];
  /** The only process owner; a host spawning through its own would issue pids at or below the revoked generation floor. */
  readonly processes: SessionProcessSupervisor;
  /** Hosts must forward their mounted facet method here, or `git clone`/`npm install` refuse. */
  readonly supervisorOp: (envelope: SupervisorOpEnvelope) => Promise<SupervisorOpResult>;
}

export interface WorkspaceBundle {
  vfs: WorkspaceVFS;
  shell: Shell;
  stats(): Promise<{ files: number; dirs: number; usedBytes: number }>;
  privileged(): Promise<WorkspacePrivileged>;
  /** Cached per uid and idempotent: a shell holds state (`cd`, exports). */
  asAgent(agent: WorkspaceAgent): Promise<WorkspaceAgentPlane>;
  session(): Promise<WorkspaceSession>;
  onFilesChanged(listener: (paths: readonly string[]) => void): () => void;
  /** Shells running as `cred` (default: session user) serve `plane`'s mounts. */
  mountTable(plane: MountedVfs, cred?: Readonly<VfsCred>): void;
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
  generation: GenerationContext;
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
  let booting: Promise<NimbusWorkspace> | undefined;

  const open = async (): Promise<NimbusWorkspace> => {
    booting ??= (async (): Promise<NimbusWorkspace> => {
      try {
        const { NimbusWorkspace } = await import('@nimbus-sh/core/workspace');
        // Boot revokes append writers at or below `generation * PID_GEN_STRIDE`, so the pid base must be
        // this generation. Fabric hides storage failures, so read before adopting and require the bump.
        const adopted = generation(opts.generation);
        const before = adopted !== 0 ? null : v.parse(v.optional(v.number()), await opts.generation.storage.get(GENERATION_KEY)) ?? 0;
        await adoptGeneration(opts.generation);
        const generationNow = generation(opts.generation);
        const expected = before === null ? adopted : before + 1;

        if (generationNow !== expected) throw new KinuError('unavailable', 'the workspace generation counter could not be persisted');

        processes.setPidBase(generationNow * PID_GEN_STRIDE);

        let creation: Parameters<typeof NimbusWorkspace.create>[0] = {
          sql: opts.sql,
          transactions: opts.transactions,
          generation: generationNow,
          cwd: WORKSPACE_ROOT,
          env: { HOME: WORKSPACE_ROOT, TMPDIR: agentTmpRoot(MAIN_AGENT) },
          processes,
          fabric: opts.fabric,
          filesystem: (authority) => mountedAuthority(authority, tableFor),
        };

        if (opts.runtimeSource !== undefined) {
          creation = { ...creation, runtimeSource: opts.runtimeSource, runtimeInstall: 'on-demand' };
        }

        const workspace = await NimbusWorkspace.create(creation);

        // After substrate registrations so a runtime bin never shadows a coreutil.
        const provisioning: Parameters<typeof provisionWorkspaceRuntimes>[0] = {
          workspace,
          runtimes: opts.runtimes ?? [],
        };

        if (opts.runtimeFacets !== undefined) provisioning.facets = opts.runtimeFacets;
        await provisionWorkspaceRuntimes(provisioning);
        const root = workspace.vfs.as(CRED_KERNEL);
        const main = agentIdentity(opts.sql, MAIN_AGENT);
        provisionAgentHome(root, MAIN_AGENT, main);
        confineAgentTmp(workspace.vfs, MAIN_AGENT, main);
        restoreAgentTmpConfinements(opts.sql, root, workspace.vfs);
        workspace.vfs.events.on((batch) => {
          if (fileListeners.size === 0) return;
          const paths = batch.map((event) => event.path);

          for (const listener of fileListeners) listener(paths);
        });

        return workspace;
      } catch (cause) {
        // Clear the cache before rethrowing: a cached rejection would poison the whole isolate.
        booting = undefined;
        diagnostics.failure(
          'workspace.boot_failed',
          toKinuError({ doing: 'boot the Nimbus workspace', cause, otherwise: 'unavailable' }),
        );
        throw cause;
      }
    })();

    return await booting;
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
      mountTables.set((cred ?? CRED_SESSION_USER).uid, plane);
    },
    async stats() { return (await open()).stats(); },
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
        registry: workspace.registry,
        processes,
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
          const { NimbusWorkspace } = await import('@nimbus-sh/core/workspace');

          const asAgent = await NimbusWorkspace.create({
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
            filesystem: (authority) => mountedAuthority(authority, tableFor),
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

/** The generation counter as a single SQLite row, so it survives eviction and restarts. */
export function workspaceGenerationStorage(sql: SqlDatabase): GenerationContext {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${GENERATION_TABLE} (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`);

  return {
    storage: {
      async get() {
        const [row] = [...sql.exec(`SELECT value FROM ${GENERATION_TABLE} WHERE id = 1`)];

        return row === undefined ? undefined : Number(row.value);
      },
      async put(_key, value) {
        sql.exec(
          `INSERT INTO ${GENERATION_TABLE} (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
          Number(value),
        );
      },
    },
  };
}
