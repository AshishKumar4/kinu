/** SandboxExecutor: @cloudflare/sandbox-backed executor, one container per agent, exposed as `sandbox.*`. */

import * as v from 'valibot';
import { isAbortError } from '@kinu.run/agent-utils';
import type { ExecutorProvider, ExecutorCapability, PortExposureResult, PreviewRouteCheck } from './types';
import { readExecSignal } from './signal';
import { commandResult, exposedPortText, type CommandResult } from './exec-result';
import { diagnostics, KinuError, refusalOf, renderThrownChain, toKinuError, type Refusal } from '../obs/index';
import type { VFS } from '../types/primitives';
import { isVfsError, makeVfsError, type VfsErrorCode } from '../vfs/errno';
import type { VfsNativeReads } from '../vfs/mounts';
import { shellQuote } from '../utils/shell';
import { vfsDirname } from '../utils/vfs-helpers';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import type { JsonValue } from '../utils/json';

/** The container's working directory and default cwd; declared here because core must not depend on @kinu.run/devbox. */
export const WORKSPACE_BACKUP_DIR = '/workspace';

/** Any HTTP answer counts, even 4xx/5xx; curl exit 7 is a refused connection. */
function healthProbeCommand(port: number): string {
  return `curl -sS -o /dev/null -m 3 -w '%{http_code}|%{exitcode}' --connect-timeout 2 `
    + `--head http://127.0.0.1:${port}/ 2>&1 || true`;
}

/** An unparsable answer is not evidence of a listener; exposing on that guess yields a URL that 502s. */
function healthProbeSilent(output: string): boolean {
  const [codeStr, exitStr] = output.trim().split('|');

  if (exitStr !== undefined && parseInt(exitStr, 10) === 7) return true;
  const code = codeStr === undefined ? Number.NaN : parseInt(codeStr, 10);

  return !Number.isFinite(code) || code === 0;
}

interface SandboxExposeOptions {
  hostname: string;
  name?: string;
  /** Supplied, never left to the SDK: see {@link SandboxHandle.portToken}. */
  token?: string;
}

/** Shared by core and every adapter; field semantics on `SandboxHandle.exec`. */
export interface SandboxExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface SandboxHandle {
  /** Every operation awaits this first so an agent never observes a half-restored workspace. */
  ensureReady(): Promise<void>;
  /**
   * `timeout` absent means no work deadline: pick a transport with none (catalog: sandbox.exec.request_ceiling_ms).
   * `signal` cancels the remote work: settle only once the process is gone; a transport with no kill must not accept one.
   */
  exec(command: string, opts?: SandboxExecOptions):
    Promise<{ output?: string; stdout?: string; stderr?: string; exitCode?: number }>;
  /** The SDK returns binary files base64-encoded with `encoding: 'base64'`; text as utf-8. */
  readFile(path: string, opts?: { encoding?: 'utf-8' | 'base64' }):
    Promise<{ content?: string; encoding?: string; isBinary?: boolean; exitCode?: number }>;
  writeFile(path: string, content: string, opts?: { encoding?: 'utf-8' | 'base64' }): Promise<JsonValue | void>;
  listFiles(path: string, opts?: { recursive?: boolean }):
    Promise<{ files: Array<{ name?: string; path?: string; type?: string; size?: number; isDirectory?: boolean }> }>;
  deleteFile(path: string): Promise<JsonValue | void>;
  /** `hostname` is the preview URL suffix; `token` comes from {@link SandboxHandle.portToken}. */
  exposePort(port: number, opts: { hostname: string; name?: string; token?: string }):
    Promise<{ url: string; port: number; name?: string; route: PreviewRouteCheck }>;
  unexposePort(port: number): Promise<JsonValue | void>;
  getExposedPorts(hostname: string):
    Promise<Array<{ url: string; port: number; name?: string; status?: string }>>;
  /** The only kind of background process that survives container sleep. */
  startSupervisedProcess(command: string, opts?: { cwd?: string }):
    Promise<{ processId: string }>;
  stopSupervisedProcess(processId: string): Promise<{ stopped: boolean }>;
  listSupervisedProcesses(): Promise<Array<{
    processId: string; pid?: number; status: string; command: string; restartable: boolean;
  }>>;
  /** Asked before the first exposure: restarts re-expose with the stored token, so the first URL must use it too. */
  portToken(port: number, name?: string): Promise<{ urlToken: string }>;
  notePortRemoved(port: number): Promise<void>;
}

const NOT_CONFIGURED =
  'Sandbox executor not configured. Add the @cloudflare/sandbox binding ' +
  'and Container to wrangler.jsonc (see docs/EXECUTION-LAYER-SPEC.md).';

const PREVIEWS_NOT_CONFIGURED =
  'Sandbox previews are off: PREVIEW_HOST_SUFFIX is unset, so there is no zone to mint preview ' +
  'hostnames on. Turning them on takes a proxied wildcard DNS record and a matching route on a zone; ' +
  'the PREVIEW_HOST_SUFFIX note in wrangler.jsonc has both steps. Exec and files still work.';

/** Lower-cased markers for transient sandbox/RPC errors, retried with backoff (STABILITY-AUDIT §B2/§B3). */
const TRANSIENT_MARKERS = [
  // First call after a stop/eviction can land while the RPC session tears down (scripts/sandbox-durability-probe.ts).
  'while the runtime connection was closing',
  'stopped while the operation was pending',
  'network connection lost',
  'container suddenly disconnected',
  'container is starting',
  'no container instance',
  'internal error in durable object storage caused object to be reset',
  'http error! status: 500',
  // Container start-rate limit (429): admission control, like 'no container instance' (503).
  'too many containers per second',
];

function parseInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: { value: unknown },
): v.InferOutput<TSchema> | undefined {
  const result = v.safeParse(schema, input.value);

  return result.success ? result.output : undefined;
}

const StringSchema = v.string();

/** The SDK refuses `''` with a defect-worded error, so the empty path is resolved in core. */
const PathSchema = v.pipe(v.string(), v.minLength(1));

const OptionalStringSchema = v.optional(v.string());

const PortSchema = v.pipe(v.number(), v.minValue(1), v.maxValue(65535));

export function isSandboxTransientError(error: Error | string): boolean {
  const msg = (error instanceof Error ? error.message : error).toLowerCase();

  return TRANSIENT_MARKERS.some(m => msg.includes(m));
}

/** No container binding. `unavailable` (not `unsupported`) matches the shell tool's code for an unprovisioned runtime.
 *  Built per call, as every refusal is: an object shared between calls would carry one caller's edits to the next. */
const notConfigured = (): Refusal => refusalOf(new KinuError('unavailable', NOT_CONFIGURED));

/** `unsupported`: the container works; no `PREVIEW_HOST_SUFFIX` means no retry can succeed. */
const previewsUnconfigured = (): Refusal => refusalOf(new KinuError('unsupported', PREVIEWS_NOT_CONFIGURED));

/** Transient markers left after retries are platform admission control, so `unavailable`, not `io`.
 *  A recognised cause keeps its own, more precise code. */
function sandboxFailure(input: { doing: string; cause: unknown }): KinuError {
  const transient = isSandboxTransientError(
    input.cause instanceof Error ? input.cause : String(input.cause),
  );

  return toKinuError({ ...input, otherwise: transient ? 'unavailable' : 'io' });
}

export class SandboxPending extends KinuError {
  constructor(reason: string) {
    super('unavailable', reason);
  }
}

/** Retries only transient errors, with exponential backoff; non-transient errors throw immediately. */
export async function withSandboxRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // A classified `unavailable` is a verdict: marker text in its reason must not re-enter the retry loop.
      if (err instanceof KinuError && err.code === 'unavailable') throw err;

      if (!isSandboxTransientError(err instanceof Error ? err : String(err)) || i === attempts - 1) {
        throw err;
      }

      await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }

  throw lastErr;
}

function normalize(res: { output?: string; stdout?: string; stderr?: string; exitCode?: number }): CommandResult {
  return commandResult({ ...res, stdout: res.stdout ?? res.output ?? '' });
}

/** Worded distinctly from the adapter's own cancellation, which names the process it killed. */
function notDispatched(): Error {
  return new DOMException(
    'sandbox exec cancelled before dispatch — no container process was started',
    'AbortError',
  );
}

/** Pass `undefined` for a "not configured" stub. Without `previewHostSuffix` only port exposure refuses. */
export function createSandboxExecutor(
  handle?: SandboxHandle,
  previewHostSuffix?: string,
): ExecutorProvider {
  const connected = handle != null;
  const previews = previewHostSuffix !== undefined && previewHostSuffix.length > 0;
  let active = false;

  const touch = async <T>(fn: () => Promise<T>): Promise<T> => {
    active = true;

    return fn();
  };

  /** `unprobeable` is not evidence either way; each caller decides what it means. */
  const probeListener = async (
    box: SandboxHandle, port: number,
  ): Promise<{ listening: boolean } | { unprobeable: unknown }> => {
    try {
      const probe = await withSandboxRetry(() => touch(() =>
        box.exec(healthProbeCommand(port), { cwd: WORKSPACE_BACKUP_DIR })));

      const out = (probe.stdout ?? probe.output ?? '').toString().trim();

      return { listening: !healthProbeSilent(out) };
    } catch (cause) {
      return { unprobeable: cause };
    }
  };

  /** The one exposure path. A probe that cannot run is stepped over: the exposure reports its own error. */
  const exposeOn = async (box: SandboxHandle, suffix: string, port: number, name?: string): Promise<PortExposureResult> => {
    const probe = await probeListener(box, port);

    if ('unprobeable' in probe) {
      diagnostics.failure('sandbox.port_probe_failed', toKinuError({
        doing: 'probe a sandbox port before exposing it', cause: probe.unprobeable, otherwise: 'unavailable',
      }), { port });
    } else if (!probe.listening) {
      return {
        supported: false,
        reason: `nothing is listening on port ${port} inside the sandbox. `
          + `Start your server FIRST with a SUPERVISED process, then call sandbox.exposePort again. Examples:\n`
          + `  • Static site: await sandbox.startProcess("python3 -m http.server ${port} --directory /workspace/<app-dir>")\n`
          + `  • Node:        await sandbox.startProcess("node server.js", {cwd:"/workspace/<app-dir>"})\n`
          + `Supervision is what makes the process survive a container restart; a bare \`nohup … &\` does not and will be lost.`,
      };
    }

    const { urlToken } = await box.portToken(port, name);
    const opts: SandboxExposeOptions = { hostname: suffix, token: urlToken };

    if (name !== undefined) opts.name = name;
    const exposed = await withSandboxRetry(() => touch(() => box.exposePort(port, opts)));

    return { supported: true, url: exposed.url, port, name, route: exposed.route };
  };

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Run a shell command in the sandbox container. '
        + 'BUN IS THE DEFAULT toolchain here (bun 1.3.12 ships in the image): use `bun install`, '
        + '`bun run`, `bun x` and `bun test` rather than npm, npx, yarn or pnpm unless a project '
        + 'genuinely requires one of those. '
        + 'A workspace restored after the container slept keeps its source and its LOCKFILES but '
        + 'not its regenerable trees (node_modules, .venv, build output): if an import fails after '
        + 'a restore, run one `bun install` before concluding anything is missing.',
      execute: async (...args: unknown[]): Promise<CommandResult> => {
        if (!handle) return notConfigured();
        const command = parseInput(StringSchema, { value: args[0] });

        if (command === undefined) {
          return refusalOf(new KinuError('bad_input', 'sandbox exec: command must be a string'));
        }

        const signal = readExecSignal({ context: args[1] });

        try {
          // No work deadline: see SandboxHandle.exec. The signal goes to the container; locally it only
          // refuses to dispatch, before the first attempt and before each retry.
          const res = await withSandboxRetry(() => touch(() => {
            if (signal?.aborted) throw notDispatched();
            // The signal is added only when given, so an adapter can tell "none" from "already fired".
            const opts: SandboxExecOptions = { cwd: '/workspace' };

            if (signal !== undefined) opts.signal = signal;

            return handle.exec(command, opts);
          }));

          return normalize(res);
        } catch (err) {
          if (isAbortError(err)) throw err;

          return refusalOf(sandboxFailure({ doing: `sandbox exec \`${command}\``, cause: err }));
        }
      },
    },
    readFile: {
      planAllowed: true,
      description: 'Read a file from the sandbox.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const path = parseInput(PathSchema, { value: args[0] });

        if (path === undefined) {
          return refusalOf(new KinuError('bad_input', 'sandbox readFile: path must be a non-empty string'));
        }

        try {
          const r = await withSandboxRetry(() => touch(() => handle.readFile(path)));

          // A failed read is only an exit code, so `io`: `missing` would over-claim.
          if (r.exitCode && r.exitCode !== 0) {
            return refusalOf(new KinuError('io', `sandbox readFile ${path}: exit ${r.exitCode}`));
          }

          return r.content ?? '';
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: `sandbox readFile ${path}`, cause: err }));
        }
      },
    },
    writeFile: {
      description: 'Write content to a file in the sandbox. Creates parent dirs.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const path = parseInput(PathSchema, { value: args[0] });
        const content = parseInput(StringSchema, { value: args[1] });

        if (path === undefined) {
          return refusalOf(new KinuError('bad_input', 'sandbox writeFile: path must be a non-empty string'));
        }

        if (content === undefined) {
          return refusalOf(new KinuError('bad_input', 'sandbox writeFile: content must be a string'));
        }

        try {
          await withSandboxRetry(() => touch(() => handle.writeFile(path, content)));

          return `wrote ${path}`;
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: `sandbox writeFile ${path}`, cause: err }));
        }
      },
    },
    listFiles: {
      planAllowed: true,
      description: 'List files in a directory — the working directory when `path` is omitted or empty. Returns newline-separated entries prefixed "d" or "-".',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const path = parseInput(OptionalStringSchema, { value: args[0] });

        if (args[0] !== undefined && path === undefined) {
          return refusalOf(new KinuError('bad_input', 'sandbox listFiles: path must be a string'));
        }

        // Absent path means the executor's working directory.
        const dir = path === undefined || path === '' ? WORKSPACE_BACKUP_DIR : path;

        try {
          const r = await withSandboxRetry(() => touch(() => handle.listFiles(dir, { recursive: false })));

          if (!r?.files?.length) return '';

          return r.files
            .map(f => {
              const name = f.name ?? f.path ?? '';
              const isDir = f.isDirectory ?? f.type === 'directory';

              return `${isDir ? 'd' : '-'} ${name}`;
            })
            .join('\n');
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: `sandbox listFiles ${dir}`, cause: err }));
        }
      },
    },
    readdir: {
      planAllowed: true,
      description: 'Alias for listFiles — list entries in a directory.',
      execute: async (...args: unknown[]) => tools.listFiles.execute(args[0]),
    },
    deleteFile: {
      description: 'Delete a file or directory.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const path = parseInput(PathSchema, { value: args[0] });

        if (path === undefined) {
          return refusalOf(new KinuError('bad_input', 'sandbox deleteFile: path must be a non-empty string'));
        }

        try {
          await withSandboxRetry(() => touch(() => Promise.resolve(handle.deleteFile(path))));

          return `deleted ${path}`;
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: `sandbox deleteFile ${path}`, cause: err }));
        }
      },
    },
    exists: {
      planAllowed: true,
      description: 'Check if a path exists — uses shell test.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const path = parseInput(PathSchema, { value: args[0] });

        // Answering 'false' would claim absence when the container could not be asked.
        if (path === undefined) {
          return refusalOf(new KinuError('bad_input', 'sandbox exists: path must be a non-empty string'));
        }

        try {
          const res = await withSandboxRetry(() => touch(() => handle.exec(`test -e ${shellQuote(path)} && echo true || echo false`)));
          const out = (res.stdout ?? res.output ?? '').trim();

          return out.includes('true') ? 'true' : 'false';
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: `sandbox exists ${path}`, cause: err }));
        }
      },
    },
    exposePort: {
      description:
        'Expose a TCP port from the sandbox. Returns the public preview URL, then one line: "verified" when a ' +
        'request to the URL reaches the container port, or "not reached" naming the preview-route gate that ' +
        'refused; that check never calls your server. PRE-REQUISITE: a SUPERVISED server must already be ' +
        'listening on the port — start it with sandbox.startProcess, never a bare `nohup … &` (unsupervised ' +
        'children die with the container and do not come back). Nothing listening is refused with the fix.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();

        if (!previewHostSuffix) return previewsUnconfigured();
        const p = parseInput(PortSchema, { value: args[0] });
        const name = parseInput(OptionalStringSchema, { value: args[1] });

        if (p === undefined) {
          return refusalOf(new KinuError('bad_input', `sandbox exposePort: invalid port ${String(args[0])}`));
        }

        try {
          const exposed = await exposeOn(handle, previewHostSuffix, p, name);

          // `bad_input`: the caller must start the server first; `unavailable` or `missing` would misfile it.
          return exposed.supported
            ? exposedPortText(exposed.url, p, exposed.route)
            : refusalOf(new KinuError('bad_input', exposed.reason));
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: `sandbox exposePort ${p}`, cause: err }));
        }
      },
    },
    unexposePort: {
      description: 'Stop exposing a port.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const port = parseInput(PortSchema, { value: args[0] });

        if (port === undefined) {
          return refusalOf(new KinuError('bad_input', `sandbox unexposePort: invalid port ${String(args[0])}`));
        }

        try {
          await withSandboxRetry(() => touch(() => Promise.resolve(handle.unexposePort(port))));
          await handle.notePortRemoved(port);

          return `unexposed ${port}`;
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: `sandbox unexposePort ${port}`, cause: err }));
        }
      },
    },
    listPorts: {
      description: 'List currently exposed ports. Returns JSON array of {port,url,status}.',
      execute: async (): Promise<string | Refusal> => {
        if (!handle) return notConfigured();

        if (!previewHostSuffix) return previewsUnconfigured();

        try {
          // The tool is listPorts, the verb both executors declare.
          const ports = await withSandboxRetry(() => touch(() => handle.getExposedPorts(previewHostSuffix)));

          return JSON.stringify((ports ?? []).map(p => ({ port: p.port, status: p.status, url: p.url })));
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: 'sandbox listPorts', cause: err }));
        }
      },
    },
    startProcess: {
      description:
        'Start a SUPERVISED background process in the sandbox. Supervision records a restart ' +
        'spec, so the process COMES BACK when the container restarts; a bare `nohup … &` does ' +
        'not and is lost. Returns JSON {processId}. Prefer this over `exec "cmd &"` for any ' +
        'long-running server.',
      execute: async (...args: unknown[]): Promise<CommandResult> => {
        if (!handle) return notConfigured();
        const command = parseInput(StringSchema, { value: args[0] });

        if (command === undefined) {
          return refusalOf(new KinuError('bad_input', 'sandbox startProcess: command must be a string'));
        }

        const rawOpts = parseInput(
          v.union([v.string(), v.object({ cwd: v.optional(v.string()) })]),
          { value: args[1] },
        );

        const cwd = parseInput(
          OptionalStringSchema,
          { value: v.is(v.string(), rawOpts) ? rawOpts : rawOpts?.cwd },
        ) ?? WORKSPACE_BACKUP_DIR;

        try {
          // Readiness is retried; the start is not: a retry after a partial start would spawn a second process.
          const started = await touch(async () => {
            await withSandboxRetry(() => handle.ensureReady());

            return handle.startSupervisedProcess(command, { cwd });
          });

          return JSON.stringify({ ...started, cwd, restartable: true });
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: `sandbox startProcess \`${command}\``, cause: err }));
        }
      },
    },
    stopProcess: {
      description: 'Stop a supervised process by id and clear its restart spec.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const processId = parseInput(StringSchema, { value: args[0] });

        if (processId === undefined) {
          return refusalOf(new KinuError('bad_input', 'sandbox stopProcess: processId must be a string'));
        }

        try {
          const result = await withSandboxRetry(() =>
            touch(() => handle.stopSupervisedProcess(processId)));

          return JSON.stringify({ processId, ...result });
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: `sandbox stopProcess ${processId}`, cause: err }));
        }
      },
    },
    listProcesses: {
      description:
        'List sandbox processes as JSON rows {processId,pid,status,restartable,command}. ' +
        '`restartable:true` rows come back after a container restart.',
      execute: async (): Promise<string | Refusal> => {
        if (!handle) return notConfigured();

        try {
          const rows = await withSandboxRetry(() => touch(async () => {
            await handle.ensureReady();

            return handle.listSupervisedProcesses();
          }));

          return JSON.stringify(rows);
        } catch (err) {
          return refusalOf(sandboxFailure({ doing: 'sandbox listProcesses', cause: err }));
        }
      },
    },
  };

  const types = `
/**
 * A Linux container of your own (2 vCPU, about 6 GB) with its own files. Relative paths resolve in
 * /workspace. It has no docker, python3, make, gcc, clang or tsc. It refuses past 10 instances (503)
 * or on a burst of starts (429); \`unavailable\` means this deployment has no container. A server
 * started with startProcess comes back when the container restarts; a nohup job does not.
 */
declare namespace sandbox {
  function exec(command: string): Promise<string | Refusal>;
  function readFile(path: string): Promise<string | Refusal>;
  function writeFile(path: string, content: string): Promise<string | Refusal>;
  /** The executor's working directory when path is omitted or empty. */
  function listFiles(path?: string): Promise<string | Refusal>;
  /** Alias for listFiles. */
  function readdir(path?: string): Promise<string | Refusal>;
  function deleteFile(path: string): Promise<string | Refusal>;
  /** "true" or "false". */
  function exists(path: string): Promise<string | Refusal>;
  /** Supervised background process: returns JSON {processId,restartable:true}. */
  function startProcess(command: string, opts?: { cwd?: string }): Promise<string | Refusal>;
  function stopProcess(processId: string): Promise<string | Refusal>;
  /** JSON rows {processId,pid,status,restartable,command}. */
  function listProcesses(): Promise<string | Refusal>;
  function exposePort(port: number, name?: string): Promise<string | Refusal>;
  function unexposePort(port: number): Promise<string | Refusal>;
  function listPorts(): Promise<string | Refusal>;
}
`.trim();

  // Probed in the deployed image (docs/EXECUTION-LAYER-SPEC.md); these are routing instructions for the model,
  // so only list what runs. python and docker are absent (exit 127).
  const capabilities: ExecutorCapability[] = [
    'javascript', 'typescript', 'native_binary',
    'shell', 'npm', 'git', 'fs_owned',
    'net_outbound', 'net_inbound', 'process_spawn', 'process_long',
  ];

  return {
    name: 'sandbox',
    kind: 'sandbox',
    files: handle ? sandboxFiles(handle) : undefined,
    homeDir: async () => WORKSPACE_BACKUP_DIR,
    capabilities: new Set(capabilities),
    isAvailable: () => connected,
    getStatus: () => {
      const seen = { configured: connected, available: connected, active };

      if (!connected) return { ...seen, status: 'not_configured', reason: NOT_CONFIGURED };

      if (!previews) return { ...seen, status: active ? 'active' : 'idle', reason: PREVIEWS_NOT_CONFIGURED };

      return { ...seen, status: active ? 'active' : 'idle' };
    },
    connect: async () => { /* sandbox starts on first RPC */ },
    disconnect: async () => { /* The sandbox DO persists, but its CONTAINER
      filesystem does NOT — the container sleeps after ~10m idle and /workspace
      is lost. Durability is the container DO's own affair: it snapshots
      /workspace to R2 periodically and restores in its container-start hook,
      before any executor can observe the container. Not this no-op close. */ },
    tools,
    types,
    positionalArgs: true,

    async exposePort(port, opts) {
      if (!handle) return { supported: false, reason: NOT_CONFIGURED };

      if (!previewHostSuffix) return { supported: false, reason: PREVIEWS_NOT_CONFIGURED };

      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        return { supported: false, reason: `invalid port ${port}` };
      }

      try {
        return await exposeOn(handle, previewHostSuffix, port, opts?.name);
      } catch (err) {
        return { supported: false, reason: renderThrownChain({ cause: err }) };
      }
    },

    async unexposePort(port) {
      if (!handle) return;
      // No catch: unexposing an unexposed port already succeeds; other errors must surface.
      await withSandboxRetry(() => touch(() => Promise.resolve(handle.unexposePort(Number(port)))));
    },

    async listExposedPorts() {
      if (!handle || !previewHostSuffix) return [];
      const ports = await withSandboxRetry(() => touch(() => handle.getExposedPorts(previewHostSuffix)));

      return (ports ?? []).map(p => ({
        port: p.port,
        url: p.url,
        name: p.name,
        status: 'unknown' as const,
      }));
    },
  };
}

/** Container files at absolute paths. stat is synthesized from the parent listing (mtime 0);
 *  `readdirStats` avoids one relisting per child. */
export function sandboxFiles(handle: SandboxHandle): VFS & Pick<VfsNativeReads, 'readdirStats' | 'readRange'> {
  const isDir = (f: { type?: string; isDirectory?: boolean }): boolean =>
    f.isDirectory ?? (f.type === 'directory' || f.type === 'dir');

  const nameOf = (f: { name?: string; path?: string }): string => {
    const p = f.name ?? f.path ?? '';

    return p.slice(p.lastIndexOf('/') + 1);
  };

  /** SDK file errors into this plane's taxonomy. `code` is a getter lost over the wire; `errorResponse` survives. */
  const SDK_ERRNO = new Map<string, VfsErrorCode>([
    ['FILE_NOT_FOUND', 'ENOENT'],
    ['FILE_EXISTS', 'EEXIST'],
    ['IS_DIRECTORY', 'EISDIR'],
    ['NOT_DIRECTORY', 'ENOTDIR'],
    ['PERMISSION_DENIED', 'EACCES'],
    ['READ_ONLY', 'EROFS'],
    ['FILESYSTEM_ERROR', 'EIO'],
    ['FILE_TOO_LARGE', 'EIO'],
    ['VALIDATION_FAILED', 'EIO'],
  ]);

  const SDK_ERRNO_BY_NAME = new Map<string, VfsErrorCode>([
    ['FileNotFoundError', 'ENOENT'],
    ['FileExistsError', 'EEXIST'],
    ['PermissionDeniedError', 'EACCES'],
    ['FileSystemError', 'EIO'],
    ['FileTooLargeError', 'EIO'],
    ['ValidationFailedError', 'EIO'],
  ]);

  const errnoOf = (cause: Error): VfsErrorCode | null => {
    if (isVfsError(cause)) return null;
    const response = 'errorResponse' in cause ? cause.errorResponse : undefined;
    const code = v.is(v.looseObject({ code: v.string() }), response) ? response.code : undefined;

    if (code !== undefined) return SDK_ERRNO.get(code) ?? 'EIO';

    if (response !== undefined) return 'EIO';

    // Only the name crossed the wire; EIO covers codes the taxonomy has no word for.
    return SDK_ERRNO_BY_NAME.get(cause.name) ?? null;
  };

  const serving = async <T>(path: string, op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;

      const code = errnoOf(cause);

      if (code === null) throw cause;

      const error = makeVfsError(code, `${cause.message} (on '${path}')`, path);
      error.cause = cause;

      throw error;
    }
  };

  return {
    async readFile(path, opts) {
      const r = await serving(path, () => handle.readFile(path));

      if (r.exitCode != null && r.exitCode !== 0) {
        throw makeVfsError('ENOENT', `no such file or directory, open '${path}' (exit ${r.exitCode})`, path);
      }

      if (r.encoding === 'base64') {
        const bytes = base64ToBytes(r.content ?? '');

        return opts?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      }

      const text = r.content ?? '';

      return opts?.encoding === 'utf8' ? text : new TextEncoder().encode(text);
    },

    /** Bounded window via `dd` + base64; the SDK's `readFile` has no offset/length. Bounds validated before use. */
    async readRange(path, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
        throw makeVfsError('EIO', 'range offset and length must be positive safe integers', path);
      }

      const r = await handle.exec(
        `set -o pipefail; dd if=${shellQuote(path)} bs=1 skip=${String(offset)} count=${String(length)} status=none | base64 -w 0`,
      );

      if ((r.exitCode ?? 0) !== 0) {
        throw makeVfsError('EIO', `${(r.stderr ?? r.output ?? '').trim() || 'range read failed'}, open '${path}'`, path);
      }

      return base64ToBytes(r.stdout ?? r.output ?? '');
    },

    async writeFile(path, data) {
      await serving(path, () => v.is(v.string(), data)
        ? handle.writeFile(path, data)
        : handle.writeFile(path, bytesToBase64(data), { encoding: 'base64' }));
    },

    async readdir(path) {
      const r = await serving(path, () => handle.listFiles(path, { recursive: false }));

      return (r.files ?? []).map(nameOf).filter((n) => n.length > 0);
    },

    async readdirStats(path) {
      const r = await serving(path, () => handle.listFiles(path, { recursive: false }));

      return (r.files ?? [])
        .map((f) => ({ name: nameOf(f), entry: f }))
        .filter(({ name }) => name.length > 0)
        .map(({ name, entry }) => ({
          name,
          stat: { size: entry.size ?? 0, mtimeMs: 0, isDir: isDir(entry) },
        }));
    },

    async stat(path) {
      const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;

      if (clean === '/' || clean === '') return { size: 0, mtimeMs: 0, isDir: true };

      const name = clean.slice(clean.lastIndexOf('/') + 1);

      // null is reserved for "no such entry"; an unlistable parent propagates.
      const files = (await serving(clean, () =>
        handle.listFiles(vfsDirname(clean), { recursive: false }))).files ?? [];

      const entry = files.find((f) => nameOf(f) === name);

      if (!entry) return null;

      return { size: entry.size ?? 0, mtimeMs: 0, isDir: isDir(entry) };
    },

    async unlink(path) { await serving(path, () => handle.deleteFile(path)); },

    async mkdir(path, opts) {
      const r = await handle.exec(`mkdir ${opts?.recursive ? '-p ' : ''}-- ${shellQuote(path)}`);

      if ((r.exitCode ?? 0) !== 0) {
        throw makeVfsError('EIO', `${(r.stderr ?? r.output ?? '').trim() || 'operation failed'}, mkdir '${path}'`, path);
      }
    },

    async exists(path) {
      const r = await handle.exec(`test -e ${shellQuote(path)} && echo true || echo false`);

      return (r.stdout ?? r.output ?? '').includes('true');
    },
  };
}
