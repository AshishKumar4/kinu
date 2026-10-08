import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Native container executor, one durable workspace per agent, exposed as sandbox.*. */

import * as v from 'valibot';
import { Effect } from 'effect';
import type { ExecutorProvider, ExecutorCapability, ExecutorStatus, PortExposureResult, PreviewRouteCheck, SandboxSize, SandboxSizes } from './types';
import { callJob, createShellSession, machineShellCall, reportsCwd, shellExecOptions, type MachineShells } from './shell-session';
import type { OutputSink } from '../types/primitives';
import { JOB_STAMP_ENV } from '../types/jobs';
import { commandResult, commandResultAt, exposedPortText, type CommandResult } from './exec-result';
import { classifyErrorCode, diagnostics, KinuError, refusalOf, renderThrownChain, settle, tolerateAsync, toKinuError, type Refusal } from '../obs/index';
import { isVfsError, isVfsErrorCode, syscallError, type VfsErrorCode } from '@nimbus-sh/core/vfs/vfs-error.js';
import { shellQuote } from '../utils/shell';
import { vfsDirname } from '../utils/vfs-helpers';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import type { JsonValue } from '../utils/json';
import { direntType } from '../vfs/dirent';

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
  env?: Record<string, string>;
  output?: OutputSink;
}

export interface SandboxPortListener {
  readonly port: number;
  readonly pid: number;
  readonly stamp: string | null;
  readonly command: string;
}

export interface SandboxHandle {
  /** Every operation awaits this first so an agent never observes a half-restored workspace. */
  ensureReady(): Promise<void>;
  /**
   * `timeout` absent means no work deadline: native container exec adds none.
   * `signal` cancels the remote work: settle only once the process is gone; a transport with no kill must not accept one.
   */
  exec(command: string, opts?: SandboxExecOptions):
    Promise<{ output?: string; stdout?: string; stderr?: string; exitCode?: number }>;
  /** `base64` is the only exact read; without it the content is UTF-8 text. */
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
  /** `stamp` read up holders' ancestry; null while down (never starts it). */
  portListeners(stamp: string, ports?: readonly number[]): Promise<readonly SandboxPortListener[] | null>;
  notePortRemoved(port: number): Promise<void>;
  /** Records the size; a container running at another size restarts at it, and one not running stays so. */
  resize(size: string): Promise<SandboxResize>;
  answerRest(answer: 'now' | 'keep'): Promise<SandboxRestAnswer>;
}

export type SandboxRestAnswer =
  | { readonly kind: 'resting' }
  | { readonly kind: 'kept'; readonly askAgainAfterMs: number }
  | { readonly kind: 'refused' | 'failed'; readonly reason: string };

function restText(answered: SandboxRestAnswer): string | Refusal {
  switch (answered.kind) {
    case 'resting':
      return 'The sandbox saved its workspace and stopped. The next sandbox call starts it again.';
    case 'kept':
      return `The sandbox keeps running. It asks again after about ${String(Math.round(answered.askAgainAfterMs / 60_000))} minutes without use.`;
    case 'refused':
      return refusalOf(new KinuError('bad_input', `sandbox rest: ${answered.reason}`));
    case 'failed':
      return refusalOf(new KinuError('io', `sandbox rest: the sandbox could not save its workspace, so it keeps running: ${answered.reason}`));
  }
}

/** `failed`: the final checkpoint failed, so the container runs on at `previous` until its next start. */
export type SandboxResize =
  | { readonly kind: 'recorded' | 'unchanged'; readonly size: string }
  | { readonly kind: 'restarted'; readonly size: string; readonly previous: string | undefined; readonly endedCommands: number }
  | { readonly kind: 'failed'; readonly size: string; readonly previous: string | undefined; readonly reason: string };

/** Everything but the lifecycle word, which each branch of `getStatus` names. */
type ExecutorStatusBase = Omit<ExecutorStatus, 'status'>;

/** `Medium (2 vCPU, 8 GiB)`: what the prompt, the types and a resize's answer call a size. */
export function sandboxSizeLabel(row: SandboxSize): string {
  return `${row.label} (${String(row.vcpu)} vCPU, ${String(Math.round(row.memoryMib / 102.4) / 10)} GiB)`;
}

function labelOf(sizes: SandboxSizes, size: string | undefined): string {
  const row = sizes.sizes.find((candidate) => candidate.size === size);

  return row === undefined ? String(size) : sandboxSizeLabel(row);
}

/** The answer to `sandbox.resize`, in the terms its declaration uses. */
function resizedText(resized: SandboxResize, sizes: SandboxSizes): string | Refusal {
  const size = labelOf(sizes, resized.size);

  switch (resized.kind) {
    case 'recorded':
      return `The sandbox is not running; it starts at ${size}.`;
    case 'unchanged':
      return `The sandbox already runs at ${size}.`;
    case 'restarted': {
      const ended = resized.endedCommands === 0 ? '' : `; ${String(resized.endedCommands)} running command${resized.endedCommands === 1 ? '' : 's'} ended`;

      return `The sandbox restarted at ${size}${resized.previous === undefined ? '' : `, from ${labelOf(sizes, resized.previous)}`}. `
        + `Files are kept, and supervised servers and exposed ports came back${ended}.`;
    }

    case 'failed':
      return refusalOf(new KinuError('io', `The sandbox still runs at ${labelOf(sizes, resized.previous)}: its final checkpoint failed `
        + `(${resized.reason}). It starts at ${size} next time.`));
  }
}

const NOT_CONFIGURED =
  'Sandbox executor not configured. Add the KinuDevbox binding ' +
  'and its container to wrangler.jsonc (see docs/EXECUTION-LAYER-SPEC.md).';

const PREVIEWS_NOT_CONFIGURED =
  'Sandbox previews are off: PREVIEW_HOST_SUFFIX is unset, so there is no zone to mint preview ' +
  'hostnames on. Turning them on takes a proxied wildcard DNS record and a matching route on a zone; ' +
  'the PREVIEW_HOST_SUFFIX note in wrangler.jsonc has both steps. Exec and files still work.';

/** Lower-cased markers for transient sandbox/RPC errors, retried with backoff (STABILITY-AUDIT §B2/§B3). */
const TRANSIENT_MARKERS = [
  // First call after a stop/eviction can land while the RPC session tears down (measured 2026-09-05, DECISIVE-2026-09-05.md).
  'while the runtime connection was closing',
  'stopped while the operation was pending',
  'network connection lost',
  'container suddenly disconnected',
  'internal error in durable object storage caused object to be reset',
  'http error! status: 500',
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

/** A transport failure left after its retries is the box out of reach, so `unavailable`, not `io`.
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

async function withSandboxRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
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

function normalize(res: { output?: string; stdout?: string; stderr?: string; exitCode?: number; cwd?: string }): CommandResult {
  return commandResult({ ...res, stdout: res.stdout ?? res.output ?? '' });
}

/** Worded distinctly from the adapter's own cancellation, which names the process it killed. */
function cancelledWhileRunning(command: string): Error {
  return new DOMException(`sandbox exec \`${command}\` cancelled while it ran`, 'AbortError');
}

function notDispatched(): Error {
  return new DOMException(
    'sandbox exec cancelled before dispatch: no container process was started',
    'AbortError',
  );
}

export interface SandboxExecutorOptions {
  /** Without it only port exposure refuses. */
  readonly previewHostSuffix?: string | undefined;
  readonly activated?: () => void;
  /** Without them there is no `resize`. */
  readonly sizes?: SandboxSizes;
  /** Where this agent's named shells keep their state; without it a name is refused. */
  readonly shells?: MachineShells;
}

/** Pass no handle for a "not configured" stub. */
export function createSandboxExecutor(handle?: SandboxHandle, options: SandboxExecutorOptions = {}): ExecutorProvider {
  const { previewHostSuffix, activated, sizes, shells } = options;
  // One call at a time per name, and a name a detached job holds answers at once.
  const names = createShellSession({ home: WORKSPACE_BACKUP_DIR, userRoots: () => [] });
  const connected = handle != null;
  const previews = previewHostSuffix !== undefined && previewHostSuffix.length > 0;
  let active = false;

  const touch = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!active) {
      active = true;
      activated?.();
    }

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
          + `  - Static site: await sandbox.startProcess("python3 -m http.server ${port} --directory /workspace/<app-dir>")\n`
          + `  - Node:        await sandbox.startProcess("node server.js", {cwd:"/workspace/<app-dir>"})\n`
          + `Supervision is what makes the process survive a container restart; a bare \`nohup ... &\` does not and will be lost.`,
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

        const exec = shellExecOptions({ value: args[1] });
        const { signal, job, output } = exec;

        if (exec.name !== undefined && shells === undefined) {
          return refusalOf(new KinuError('unsupported', 'sandbox exec: this runtime keeps no named shells'));
        }

        const call = machineShellCall(command, exec, { home: WORKSPACE_BACKUP_DIR, scope: shells?.scope ?? '', stateDirectory: shells?.stateDirectory ?? '' });

        try {
          // No work deadline: see SandboxHandle.exec. The signal goes to the container; locally it only refuses to
          // dispatch. One call: the handle owns any re-call after a lost reply, under the call's one launch id.
          return await names.hold(exec.name, callJob(exec), async () => {
            const res = await touch(() => {
              if (signal?.aborted) throw notDispatched();
              // The signal is added only when given, so an adapter can tell "none" from "already fired".
              const opts: SandboxExecOptions = { cwd: WORKSPACE_BACKUP_DIR };

              if (signal !== undefined) opts.signal = signal;

              if (job !== undefined) opts.env = { [JOB_STAMP_ENV]: job };

              if (output !== undefined) opts.output = call.output(output);

              return handle.exec(call.command, opts);
            });

            const settled = call.settle({ ...res, stdout: res.stdout ?? res.output ?? '' });

            return reportsCwd({ context: args[1] }) ? commandResultAt(settled) : normalize(settled);
          }, (message) => refusalOf(new KinuError('unavailable', message)));
        } catch (err) {
          const own = classifyErrorCode({ cause: err }) === 'cancelled';

          // The caller's cancel wins over what the call it cut short answered.
          if (own || signal?.aborted === true) throw own ? err : cancelledWhileRunning(command);

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
      description: 'List files in a directory: the working directory when `path` is omitted or empty. Returns newline-separated entries prefixed "d" or "-".',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const path = parseInput(OptionalStringSchema, { value: args[0] });

        if (args[0] !== undefined && path === undefined) {
          return refusalOf(new KinuError('bad_input', 'sandbox listFiles: path must be a string'));
        }

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
      description: 'Alias for listFiles: list entries in a directory.',
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
      description: 'Check if a path exists: uses shell test.',
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
        'listening on the port: start it with sandbox.startProcess, never a bare `nohup ... &` (unsupervised ' +
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
        'spec, so the process COMES BACK when the container restarts; a bare `nohup ... &` does ' +
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
    rest: {
      description:
        'Answer the sandbox\'s rest ask. When it has gone unused while processes still run in it, it asks you: ' +
        '"now" saves it and stops it, ending what runs (supervised servers restart cold on their next use); ' +
        '"keep" leaves it running until it asks again.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const answer = parseInput(v.picklist(['now', 'keep']), { value: args[0] });

        if (answer === undefined) return refusalOf(new KinuError('bad_input', 'sandbox rest: the answer must be "now" or "keep"'));

        return settle(Effect.match(Effect.tryPromise({
          try: () => handle.answerRest(answer),
          catch: (cause) => sandboxFailure({ doing: `sandbox rest ${answer}`, cause }),
        }), { onSuccess: restText, onFailure: refusalOf }));
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

  if (sizes !== undefined) {
    tools.resize = {
      description: 'Change the sandbox\'s size. A running sandbox at another size restarts: files stay, '
        + 'supervised servers and exposed ports come back, and a running command ends.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        if (!handle) return notConfigured();
        const size = parseInput(v.picklist(sizes.sizes.map((row) => row.size)), { value: args[0] });

        if (size === undefined) {
          return refusalOf(new KinuError('bad_input', `sandbox resize: size must be one of ${sizes.sizes.map((row) => row.size).join(', ')}`));
        }

        // Retried: a resize repeated after a lost answer finds its size already applied.
        return settle(Effect.match(Effect.tryPromise({
          try: () => withSandboxRetry(() => touch(() => handle.resize(size))),
          catch: (cause) => sandboxFailure({ doing: `sandbox resize ${size}`, cause }),
        }), { onSuccess: (resized) => resizedText(resized, sizes), onFailure: refusalOf }));
      },
    };
  }


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
    filesOwner: 'agent',
    isAvailable: () => connected,
    getStatus: () => {
      const seen: ExecutorStatusBase = { configured: connected, available: connected, active };

      if (!connected) return { ...seen, status: 'not_configured', reason: NOT_CONFIGURED };

      if (sizes !== undefined) seen.sizes = sizes;

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
 *  dirent stats avoid one relisting per child. */
export function sandboxFiles(handle: SandboxHandle): VFS & Required<Pick<VFS, 'readRange'>> {
  const isDir = (f: { type?: string; isDirectory?: boolean }): boolean =>
    f.isDirectory ?? (f.type === 'directory' || f.type === 'dir');

  const nameOf = (f: { name?: string; path?: string }): string => {
    const p = f.name ?? f.path ?? '';

    return p.slice(p.lastIndexOf('/') + 1);
  };

  const errnoOf = (cause: Error): VfsErrorCode | null => {
    if (isVfsError(cause)) return null;
    const visited = new Set<Error>();

    for (let current: unknown = cause; current instanceof Error && !visited.has(current); current = current.cause) {
      visited.add(current);
      const detail = v.safeParse(v.object({ kind: v.literal('devbox.file'), code: v.string() }), current.cause);

      if (!detail.success) continue;
      const { code } = detail.output;

      return isVfsErrorCode(code) ? code : 'EIO';
    }

    return null;
  };

  const serving = async <T>(path: string, syscall: string, op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;

      const code = errnoOf(cause);

      if (code === null) throw cause;

      throw syscallError(code, syscall, path, { cause });
    }
  };

  return {
    async readFile(path) {
      const result = await serving(path, 'open', () => handle.readFile(path, { encoding: 'base64' }));

      if (result.exitCode != null && result.exitCode !== 0) {
        throw syscallError('ENOENT', 'open', path, { detail: `no such file or directory (exit ${result.exitCode})` });
      }

      return result.encoding === 'base64' ? base64ToBytes(result.content ?? '') : new TextEncoder().encode(result.content ?? '');
    },

    /** Bounded window via `dd` + base64; the SDK's `readFile` has no offset/length. Bounds validated before use. */
    async readRange(path, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
        throw syscallError('EIO', 'read', path, { detail: 'range offset and length must be positive safe integers' });
      }

      const r = await handle.exec(
        `set -o pipefail; dd if=${shellQuote(path)} bs=1 skip=${String(offset)} count=${String(length)} status=none | base64 -w 0`,
      );

      if ((r.exitCode ?? 0) !== 0) {
        throw syscallError('EIO', 'read', path, { detail: (r.stderr ?? r.output ?? '').trim() || undefined });
      }

      return base64ToBytes(r.stdout ?? r.output ?? '');
    },

    async writeFile(path, data) {
      await serving(path, 'open', () => handle.writeFile(path, bytesToBase64(data), { encoding: 'base64' }));
    },

    async readdir(path) {
      const result = await serving(path, 'scandir', () => handle.listFiles(path, { recursive: false }));

      return (result.files ?? [])
        .map((entry) => ({ name: nameOf(entry), entry }))
        .filter(({ name }) => name.length > 0)
        .map(({ name, entry }) => {
          const type = isDir(entry) ? 'directory' : direntType(entry.type);

          return { name, type, ...((type === 'file' || type === 'directory') && { stat: { size: entry.size ?? 0, mtimeMs: 0, type } }) };
        });
    },

    // The devbox lists by lstat, so only `follow: false` can name a link; a followed stat keeps the listed entry.
    async stat(path, options) {
      const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;

      if (clean === '/' || clean === '') return { size: 0, mtimeMs: 0, type: 'directory' };

      const name = clean.slice(clean.lastIndexOf('/') + 1);

      const listing = await tolerateAsync(() => serving(clean, 'stat', () =>
        handle.listFiles(vfsDirname(clean), { recursive: false })), 'enoent');

      if (listing === undefined) return null;
      const entry = (listing.files ?? []).find((file) => nameOf(file) === name);

      if (!entry) return null;

      const size = entry.size ?? 0;

      if (options?.follow === false && entry.type === 'symlink') return { size, mtimeMs: 0, type: 'symlink' };

      return { size, mtimeMs: 0, type: isDir(entry) ? 'directory' : 'file' };
    },

    async unlink(path) { await serving(path, 'unlink', () => handle.deleteFile(path)); },

    async mkdir(path, opts) {
      const r = await handle.exec(`mkdir ${opts?.recursive ? '-p ' : ''}-- ${shellQuote(path)}`);

      if ((r.exitCode ?? 0) !== 0) {
        throw syscallError('EIO', 'mkdir', path, { detail: (r.stderr ?? r.output ?? '').trim() || undefined });
      }
    },

  };
}
