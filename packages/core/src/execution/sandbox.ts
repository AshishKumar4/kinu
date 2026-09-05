/**
 * SandboxExecutor — @cloudflare/sandbox-backed executor.
 *
 * Each agent gets its own Linux container via a Sandbox DO. The orchestrator
 * passes a SandboxHandle (duck-typed here so core stays dep-free) obtained
 * from `getSandbox(env.SANDBOX, agentId)`.
 *
 * Namespace inside codemode sandbox: `sandbox.*`
 *   sandbox.exec("npm test")
 *   sandbox.readFile("/workspace/app.ts")
 *   sandbox.writeFile("/workspace/util.ts", code)
 *   sandbox.listFiles("/workspace")
 *   sandbox.deleteFile("/workspace/tmp.txt")
 *   sandbox.exposePort(3000, { name: "dev" })
 *   sandbox.unexposePort(3000)
 *   sandbox.listPorts()
 */

import * as v from 'valibot';
import { isAbortError } from '@kinu.run/agent-utils';
import type { ExecutorProvider, ExecutorCapability } from './types';
import { readExecSignal } from './signal';
import { formatExecResult, refusalText } from './exec-result';
import { diagnostics, KinuError, renderThrownChain, toKinuError } from '../obs/index';
import type { VFS } from '../types/primitives';
import { makeVfsError } from '../vfs/errno';
import type { VfsNativeReads } from '../vfs/mounts';
import { shellQuote } from '../utils/shell';
import { vfsDirname } from '../utils/vfs-helpers';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import type { JsonValue } from '../utils/json';
/** The container's working directory, and the executor's default cwd. Kinu's
 *  own constant now: the durability machinery that used to define it moved to
 *  @kinu.run/devbox, and core must not depend on a host package. */
export const WORKSPACE_BACKUP_DIR = '/workspace';

/** Shell probe deciding whether anything listens on a container port. Any HTTP
 *  answer counts, even 4xx/5xx; curl exit 7 is a refused connection. */
function healthProbeCommand(port: number): string {
  return `curl -sS -o /dev/null -m 3 -w '%{http_code}|%{exitcode}' --connect-timeout 2 `
    + `--head http://127.0.0.1:${port}/ 2>&1 || true`;
}

/** True when the probe says nothing is listening — or says nothing at all. An
 *  unparsable answer is not evidence of a listener, and exposing a port on that
 *  guess hands back a URL that 502s. */
function healthProbeSilent(output: string): boolean {
  const [codeStr, exitStr] = output.trim().split('|');
  if (exitStr !== undefined && parseInt(exitStr, 10) === 7) return true;
  const code = codeStr === undefined ? Number.NaN : parseInt(codeStr, 10);
  return !Number.isFinite(code) || code === 0;
}

interface SandboxExposeOptions {
  hostname: string;
  name?: string;
  /** The token the preview URL is built on. Supplied, never left to the SDK:
   *  see {@link SandboxHandle.portToken}. */
  token?: string;
}

/**
 * Duck-typed handle — matches the subset of @cloudflare/sandbox's getSandbox()
 * return value we consume. Core accepts `unknown`-typed handles and narrows
 * here, so cf-backend can supply the real thing without core having a
 * package dependency.
 *
 * The SDK's `exposePort` enables in-container port forwarding, stores a secret
 * token in DO storage, and returns the preview URL it serves that port on:
 * `https://<port>-<sandbox>-<token>.<previewHostSuffix>`. Kinu hands that
 * URL straight through — the Worker routes it back with the SDK's own
 * `proxyToSandbox` (packages/cf-backend/src/preview-proxy.ts).
 */
/**
 * What a caller may ask of {@link SandboxHandle.exec}.
 *
 * Named because BOTH ends build it: core assembles one here and every adapter
 * reads it, so an anonymous restatement at either end is a second copy of the
 * same contract. See `SandboxHandle.exec` for what each field means and what an
 * adapter owes it.
 */
export interface SandboxExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface SandboxHandle {
  /** Resolve once this container generation's post-start restoration has
   *  settled (processes restarted, ports re-exposed). Every operation here
   *  awaits it first so an agent never observes a half-restored workspace. */
  ensureReady(): Promise<void>;
  /**
   * Run a command and resolve with what it produced.
   *
   * `timeout` ABSENT means the call carries NO WORK DEADLINE, and an adapter
   * must honour that by choosing a transport that has none. For the Cloudflare
   * SDK that is NOT its plain `exec`, which is bounded twice over — a command
   * deadline the container enforces, and the SDK's non-streaming request
   * ceiling, `sandbox.exec.request_ceiling_ms` in the platform catalog — so
   * "no deadline" is the process lane rather than a bigger number. See
   * `adaptCloudflareSandbox` in the cf runtime.
   *
   * `timeout` PRESENT means a caller asked for a deadline and wants the kill.
   * Nothing in this module ever sets one. A detach window bounds a WAIT; a lane
   * deadline silently outranks every window larger than itself, which is how a
   * 30s detach that worked became a 60s kill on the 300s one-shot surface.
   *
   * `signal` CANCELS THE REMOTE WORK, not the wait. An adapter that takes it
   * must reach the process it started and kill it, and must not settle until
   * that process is definitively gone — killed, exited, or absent from the
   * container's own process table. Settling earlier reports `cancelled` over a
   * command that is still writing to the workspace, which is exactly what this
   * contract used to permit: core raced the signal against the wait, abandoned
   * the wait, and told the agent the command "may still finish inside the
   * container". An adapter whose transport has no kill must not accept a
   * signal, so the gap stays visible in the type rather than in a sentence.
   */
  exec(command: string, opts?: SandboxExecOptions):
    Promise<{ output?: string; stdout?: string; stderr?: string; exitCode?: number }>;
  /** The SDK auto-detects binary files and returns their content base64-
   *  encoded with `encoding: 'base64'`; text comes back as plain utf-8. */
  readFile(path: string, opts?: { encoding?: 'utf-8' | 'base64' }):
    Promise<{ content?: string; encoding?: string; isBinary?: boolean; exitCode?: number }>;
  /** Pass `encoding: 'base64'` to write binary content byte-exactly. */
  writeFile(path: string, content: string, opts?: { encoding?: 'utf-8' | 'base64' }): Promise<JsonValue | void>;
  listFiles(path: string, opts?: { recursive?: boolean }):
    Promise<{ files: Array<{ name?: string; path?: string; type?: string; size?: number; isDirectory?: boolean }> }>;
  deleteFile(path: string): Promise<JsonValue | void>;
  /** Expose a port; `hostname` is the suffix the returned preview URL is built
   *  on, and `token` is the durable one from {@link SandboxHandle.portToken}. */
  exposePort(port: number, opts: { hostname: string; name?: string; token?: string }):
    Promise<{ url: string; port: number; name?: string }>;
  unexposePort(port: number): Promise<JsonValue | void>;
  /** SDK method is `getExposedPorts(hostname)`; `hostname` builds each row's `url`. */
  getExposedPorts(hostname: string):
    Promise<Array<{ url: string; port: number; name?: string; status?: string }>>;
  /** Start a SUPERVISED background process and record its restart spec — the
   *  only kind of background process that survives container sleep. */
  startSupervisedProcess(command: string, opts?: { cwd?: string }):
    Promise<{ processId: string }>;
  stopSupervisedProcess(processId: string): Promise<{ stopped: boolean }>;
  listSupervisedProcesses(): Promise<Array<{
    processId: string; pid?: number; status: string; command: string; restartable: boolean;
  }>>;
  /**
   * The durable token this port's preview URL is built on, minted on first ask.
   *
   * ASKED BEFORE THE EXPOSURE, not recorded after it. The restart path
   * re-exposes each port with its stored token, which is the whole reason a
   * preview URL survives a container recycle byte for byte — so the FIRST
   * exposure has to use that same token. Recording a freshly-minted one
   * afterwards left the caller holding a URL built on the SDK's own token and
   * the manifest holding a different one, and the URL died on the first
   * recycle.
   */
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

/**
 * Substring markers (lower-cased) for transient sandbox/RPC errors that the
 * SDK either auto-retries via 503 or does NOT retry at all (mid-request 500
 * with body 'Container suddenly disconnected, try again' — see
 * @cloudflare/containers/dist/lib/container.js:947-948). Cross-DO RPC drops
 * surface as 'Network connection lost.' before the SDK ever runs. We retry
 * any of these once with exponential-ish backoff. (STABILITY-AUDIT §B2/§B3.)
 */
const TRANSIENT_MARKERS = [
  // MEASURED on a real container (scripts/sandbox-durability-probe.ts, P2): the
  // first call after a stop/eviction can land while the RPC session is tearing
  // down. The container is coming back; surfacing this to the agent would make
  // an ordinary restart look like a tool failure.
  'while the runtime connection was closing',
  'stopped while the operation was pending',
  'network connection lost',
  'container suddenly disconnected',
  'container is starting',
  'no container instance',
  'internal error in durable object storage caused object to be reset',
  // 0.8.11 SDK started classifying this as transient; cover us either way:
  'http error! status: 500',
  // The per-second container START rate limit, returned as 429 by
  // `containerFetch` (@cloudflare/containers/dist/lib/container.js:9 defines the
  // text, :58 the predicate, :870 the response). A rate limit is transient by
  // definition, and it was the one admission refusal NOT listed here — so a
  // burst of parallel escalations surfaced it to the model as a hard failure
  // while the concurrency ceiling beside it ('no container instance', 503) was
  // retried. Both are admission control, so both belong here.
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
const OptionalStringSchema = v.optional(v.string());
const PortSchema = v.pipe(v.number(), v.minValue(1), v.maxValue(65535));

export function isSandboxTransientError(error: Error | string): boolean {
  const msg = (error instanceof Error ? error.message : error).toLowerCase();
  return TRANSIENT_MARKERS.some(m => msg.includes(m));
}

/**
 * The binding is absent from wrangler.jsonc, so this deployment has no container
 * at all. The stub is still registered (cf-backend/src/runtime.ts:509,512) so the
 * UI can name it, which means every tool here is reachable and has to answer.
 *
 * `unavailable`, and deliberately not `unsupported`: it is the same fact the
 * `run` tool already spells `unavailable` when a runtime is not registered
 * (tools/builtins.ts, `runtime_not_provisioned`), and one fact given two codes
 * splits one platform gap across two parts of the census. It lands in
 * `runtimeMissing`, whose definition is exactly this — an environment Kinu
 * never provisioned, neither a defect in the tool nor the work failing.
 *
 * It used to land nowhere at all: prose beginning `Sandbox executor not
 * configured` is not a failure to `isFailingResultText`, so an escalation into an
 * unconfigured sandbox was recorded as a clean `ok` call.
 */
const NOT_CONFIGURED_REFUSAL = refusalText(new KinuError('unavailable', NOT_CONFIGURED));

/** `unsupported`, not `unavailable`: the container IS here and its exec and file
 *  surfaces work in full — what is missing is a zone to mint preview hostnames
 *  on. No retry reaches a `PREVIEW_HOST_SUFFIX` that was never set, and that
 *  permanence is the whole distinction between the two codes. */
const PREVIEWS_REFUSAL = refusalText(new KinuError('unsupported', PREVIEWS_NOT_CONFIGURED));

/**
 * Classify a failure raised by the container's own RPC.
 *
 * `TRANSIENT_MARKERS` is ADMISSION CONTROL, not a broken tool: 503 at the ten-
 * instance concurrency ceiling, 429 on the container start-rate burst, and the
 * eviction disconnect window. `withSandboxRetry` has already spent its three
 * attempts before anything reaches here, so what is left is a container Kinu
 * could not get — `unavailable`, the same code an unprovisioned runtime gets, in
 * the platform part of the census. Calling it `io` would count the platform's own
 * capacity ceiling as a candidate defect in this tool.
 *
 * A cause the classifier recognises keeps its own code: an abort, a timeout or the
 * memory wall is more precise than either answer here.
 */
function sandboxFailure(input: { doing: string; cause: unknown }): KinuError {
  const transient = isSandboxTransientError(
    input.cause instanceof Error ? input.cause : String(input.cause),
  );
  return toKinuError({ ...input, otherwise: transient ? 'unavailable' : 'io' });
}

/**
 * Run `fn` with up to `attempts` total tries, retrying only on transient
 * errors. Backoff: 500ms, 1000ms (i.e. 500ms × 2^attempt). Non-transient
 * errors throw immediately. Used to swallow the brief disconnect window
 * during container/DO eviction without forcing the agent to error-handle.
 * Exported for other consumers of the same raw handle (release exec).
 */
export async function withSandboxRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isSandboxTransientError(err instanceof Error ? err : String(err)) || i === attempts - 1) {
        throw err;
      }
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

function normalize(res: { output?: string; stdout?: string; stderr?: string; exitCode?: number }): string {
  // @cloudflare/sandbox returns { stdout, stderr, exitCode }; older versions
  // returned { output, exitCode }. Accept both.
  return formatExecResult({ ...res, stdout: res.stdout ?? res.output ?? '' });
}

/** The caller gave up before this attempt reached the container, so there is no
 *  remote process to cancel and nothing to wait for. Distinct wording from the
 *  adapter's own cancellation, which names the process it killed. */
function notDispatched(): Error {
  return new DOMException(
    'sandbox exec cancelled before dispatch — no container process was started',
    'AbortError',
  );
}

/**
 * Build an ExecutorProvider from a live SandboxHandle.
 * Pass `undefined` to get a "not configured" stub that appears in the UI's
 * Not-configured footer without breaking the router.
 *
 * @param handle             SDK `getSandbox()` result.
 * @param previewHostSuffix  `env.PREVIEW_HOST_SUFFIX` — the zone previews are
 *                           served under; the SDK builds every preview URL on
 *                           it. Optional: without it exec/files work in full
 *                           and only the port-exposure surface refuses, with
 *                           the preview-specific reason.
 */
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

  /**
   * Does anything answer on `port` inside the container?
   *
   * `unprobeable` is not evidence either way, and what to do about it is left
   * to the caller because the two surfaces below genuinely differ: the codemode
   * tool records a probe glitch and lets the SDK call report its own failure,
   * while the generic provider method refuses — the shell swallows curl's own
   * failure with `|| true`, so all that is left is "this container cannot
   * execute a command", and exposing a port on such a container has nothing
   * left to mean.
   */
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

  /**
   * The public URL `port` becomes reachable at, with THE DURABLE TOKEN MINTED
   * FIRST — so the URL handed back is the URL the restart path rebuilds.
   * Minting it afterwards published one token and stored another, and the
   * caller's link died on the first recycle. One implementation, because the
   * codemode tool and the generic provider method must not disagree about that
   * order.
   */
  const exposeWithDurableToken = async (
    box: SandboxHandle, suffix: string, port: number, name?: string,
  ): Promise<string> => {
    const { urlToken } = await box.portToken(port, name);
    const opts: SandboxExposeOptions = { hostname: suffix, token: urlToken };
    if (name !== undefined) opts.name = name;
    return (await withSandboxRetry(() => touch(() => box.exposePort(port, opts)))).url;
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
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        const command = parseInput(StringSchema, { value: args[0] });
        if (command === undefined) {
          return refusalText(new KinuError('bad_input', 'sandbox exec: command must be a string'));
        }
        const signal = readExecSignal({ context: args[1] });
        try {
          // NO WORK DEADLINE — see SandboxHandle.exec. This call used to send
          // `timeout: 60_000`, and the container echoed that number back as
          // `Command timeout after 60000ms`, which is why the string appears
          // nowhere in this repository. A 60s lane ceiling outranks every
          // detach window above it, so a long command on the 300s one-shot
          // surface was killed where it should have detached.
          //
          // THE SIGNAL GOES TO THE CONTAINER, and nothing here races it. The
          // adapter owns the process id, so it is the only layer that can kill
          // the command an abort is about; racing the wait here instead let the
          // turn move on while that command kept writing to /workspace. What
          // the signal still does locally is refuse to DISPATCH — once before
          // the first attempt and again before each retry, because a transient
          // failure must not start a second process for a caller that has
          // already given up.
          const res = await withSandboxRetry(() => touch(() => {
            if (signal?.aborted) throw notDispatched();
            // /workspace is the REAL default cwd — stated in the doctrine below
            // and passed explicitly so the container cannot outvote it. The
            // signal is added only when a caller gave one, so an adapter can
            // still tell "no cancellation asked for" from "cancellation asked
            // for and already fired".
            const opts: SandboxExecOptions = { cwd: '/workspace' };
            if (signal !== undefined) opts.signal = signal;
            return handle.exec(command, opts);
          }));
          return normalize(res);
        } catch (err) {
          if (isAbortError(err)) throw err;
          return refusalText(sandboxFailure({ doing: `sandbox exec \`${command}\``, cause: err }));
        }
      },
    },
    readFile: {
      description: 'Read a file from the sandbox.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'sandbox readFile: path must be a string'));
        }
        try {
          const r = await withSandboxRetry(() => touch(() => handle.readFile(path)));
          // The SDK reports a failed read as an exit code and nothing else, so
          // `io` is all the evidence supports: `missing` would claim the path is
          // absent when a permission or a decode failure exits the same way.
          if (r.exitCode && r.exitCode !== 0) {
            return refusalText(new KinuError('io', `sandbox readFile ${path}: exit ${r.exitCode}`));
          }
          return r.content ?? '';
        } catch (err) {
          return refusalText(sandboxFailure({ doing: `sandbox readFile ${path}`, cause: err }));
        }
      },
    },
    writeFile: {
      description: 'Write content to a file in the sandbox. Creates parent dirs.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(StringSchema, { value: args[0] });
        const content = parseInput(StringSchema, { value: args[1] });
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'sandbox writeFile: path must be a string'));
        }
        if (content === undefined) {
          return refusalText(new KinuError('bad_input', 'sandbox writeFile: content must be a string'));
        }
        try {
          await withSandboxRetry(() => touch(() => handle.writeFile(path, content)));
          return `wrote ${path}`;
        } catch (err) {
          return refusalText(sandboxFailure({ doing: `sandbox writeFile ${path}`, cause: err }));
        }
      },
    },
    listFiles: {
      description: 'List files in a directory. Returns newline-separated entries prefixed "d" or "-".',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(OptionalStringSchema, { value: args[0] });
        if (args[0] !== undefined && path === undefined) {
          return refusalText(new KinuError('bad_input', 'sandbox listFiles: path must be a string'));
        }
        try {
          const r = await withSandboxRetry(() => touch(() => handle.listFiles(path ?? '/', { recursive: false })));
          if (!r?.files?.length) return '';
          return r.files
            .map(f => {
              const name = f.name ?? f.path ?? '';
              const isDir = f.isDirectory ?? f.type === 'directory';
              return `${isDir ? 'd' : '-'} ${name}`;
            })
            .join('\n');
        } catch (err) {
          return refusalText(sandboxFailure({ doing: `sandbox listFiles ${path ?? '/'}`, cause: err }));
        }
      },
    },
    readdir: {
      description: 'Alias for listFiles — list entries in a directory.',
      // Straight through — `listFiles` already answers with the rendered
      // listing or its own refusal, and re-validating it here could only
      // throw over its own return type.
      execute: async (...args: unknown[]) => tools.listFiles.execute(args[0]),
    },
    deleteFile: {
      description: 'Delete a file or directory.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'sandbox deleteFile: path must be a string'));
        }
        try {
          await withSandboxRetry(() => touch(() => Promise.resolve(handle.deleteFile(path))));
          return `deleted ${path}`;
        } catch (err) {
          return refusalText(sandboxFailure({ doing: `sandbox deleteFile ${path}`, cause: err }));
        }
      },
    },
    exists: {
      description: 'Check if a path exists — uses shell test.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        const path = parseInput(StringSchema, { value: args[0] });
        // `'false'` is what this answered, and it is a claim the path is absent
        // — the one thing a caller that could not be asked must never say
        // (AGENTS.md: an empty read is distinguishable from a failed read).
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'sandbox exists: path must be a string'));
        }
        try {
          const res = await withSandboxRetry(() => touch(() => handle.exec(`test -e ${shellQuote(path)} && echo true || echo false`)));
          const out = (res.stdout ?? res.output ?? '').trim();
          return out.includes('true') ? 'true' : 'false';
        } catch (err) {
          return refusalText(sandboxFailure({ doing: `sandbox exists ${path}`, cause: err }));
        }
      },
    },
    exposePort: {
      description:
        'Expose a TCP port from the sandbox and return the public preview URL. ' +
        'PRE-REQUISITE: a SUPERVISED server must already be listening on the port — start it ' +
        'with sandbox.startProcess, never a bare `nohup … &` (unsupervised children die with ' +
        'the container and do not come back). The call verifies the port responds (HTTP HEAD ' +
        'against localhost) and names the fix if nothing listens.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        if (!previewHostSuffix) return PREVIEWS_REFUSAL;
        const p = parseInput(PortSchema, { value: args[0] });
        const name = parseInput(OptionalStringSchema, { value: args[1] });
        if (p === undefined) {
          return refusalText(new KinuError('bad_input', `sandbox exposePort: invalid port ${String(args[0])}`));
        }
        // Pre-flight: verify a server is listening on the port inside the
        // container. Without this we hand back a preview URL that 502s
        // because nothing answers — the failure mode the agent (and user)
        // actually hit. Any HTTP status, even 4xx/5xx, means a server is up;
        // connection refused means no listener.
        const probe = await probeListener(handle, p);
        if ('unprobeable' in probe) {
          // The probe failed for a non-listener reason (sandbox exec errored).
          // Recorded, then stepped over — the SDK exposePort call below will
          // surface its own error if exposure cannot be set up, and the happy
          // path is not gated on a probe glitch.
          diagnostics.failure(
            'sandbox.port_probe_failed',
            toKinuError({
              doing: 'probe a sandbox port before exposing it',
              cause: probe.unprobeable,
              otherwise: 'unavailable',
            }),
            { port: p },
          );
        } else if (!probe.listening) {
          // `bad_input`, and it is the honest one of three near misses. Nothing
          // was tried, and what must change is the caller's own request — start
          // the server, then ask again. `unavailable` would file a container
          // that is up and healthy under the platform gap that means Kinu
          // never provisioned one, and `missing` is not a refusal at all, so it
          // would land a correct decline in the candidate-defect part of the
          // census (read-models/tool-failures.ts).
          return refusalText(new KinuError('bad_input',
            `nothing is listening on port ${p} inside the sandbox. `
            + `Start your server FIRST with a SUPERVISED process, then call `
            + `sandbox.exposePort again. Examples:\n`
            + `  • Static site: await sandbox.startProcess(`
            + `"python3 -m http.server ${p} --directory /workspace/<app-dir>")\n`
            + `  • Node:        await sandbox.startProcess("node server.js", {cwd:"/workspace/<app-dir>"})\n`
            + `Supervision is what makes the process survive a container restart; `
            + `a bare \`nohup … &\` does not and will be lost.`,
          ));
        }
        try {
          return await exposeWithDurableToken(handle, previewHostSuffix, p, name);
        } catch (err) {
          return refusalText(sandboxFailure({ doing: `sandbox exposePort ${p}`, cause: err }));
        }
      },
    },
    unexposePort: {
      description: 'Stop exposing a port.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        const port = parseInput(PortSchema, { value: args[0] });
        if (port === undefined) {
          return refusalText(new KinuError('bad_input', `sandbox unexposePort: invalid port ${String(args[0])}`));
        }
        try {
          await withSandboxRetry(() => touch(() => Promise.resolve(handle.unexposePort(port))));
          await handle.notePortRemoved(port);
          return `unexposed ${port}`;
        } catch (err) {
          return refusalText(sandboxFailure({ doing: `sandbox unexposePort ${port}`, cause: err }));
        }
      },
    },
    listPorts: {
      description: 'List currently exposed ports. Returns JSON array of {port,url,status}.',
      execute: async (): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        if (!previewHostSuffix) return PREVIEWS_REFUSAL;
        try {
          // The SDK method is getExposedPorts; the tool is listPorts because that
          // is the one verb both executors declare (nimbus's own API is ports.list).
          const ports = await withSandboxRetry(() => touch(() => handle.getExposedPorts(previewHostSuffix)));
          return JSON.stringify((ports ?? []).map(p => ({ port: p.port, status: p.status, url: p.url })));
        } catch (err) {
          return refusalText(sandboxFailure({ doing: 'sandbox listPorts', cause: err }));
        }
      },
    },
    startProcess: {
      description:
        'Start a SUPERVISED background process in the sandbox. Supervision records a restart ' +
        'spec, so the process COMES BACK when the container restarts; a bare `nohup … &` does ' +
        'not and is lost. Returns JSON {processId}. Prefer this over `exec "cmd &"` for any ' +
        'long-running server.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        const command = parseInput(StringSchema, { value: args[0] });
        if (command === undefined) {
          return refusalText(new KinuError('bad_input', 'sandbox startProcess: command must be a string'));
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
          // Readiness is retried; the START is not. Creating a supervised
          // process and recording its durable spec are two steps inside the
          // container, so a failure between them leaves a live process with no
          // spec — and a retry, which can only look for a spec, starts a second
          // one. Two processes then fight over one port and the unrecorded one
          // cannot be listed, stopped or restored. Waking the container creates
          // nothing, so the transient window the retry exists for is still
          // covered, and one call now makes at most one process.
          const started = await touch(async () => {
            await withSandboxRetry(() => handle.ensureReady());
            return handle.startSupervisedProcess(command, { cwd });
          });
          return JSON.stringify({ ...started, cwd, restartable: true });
        } catch (err) {
          return refusalText(sandboxFailure({ doing: `sandbox startProcess \`${command}\``, cause: err }));
        }
      },
    },
    stopProcess: {
      description: 'Stop a supervised process by id and clear its restart spec.',
      execute: async (...args: unknown[]): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        const processId = parseInput(StringSchema, { value: args[0] });
        if (processId === undefined) {
          return refusalText(new KinuError('bad_input', 'sandbox stopProcess: processId must be a string'));
        }
        try {
          const result = await withSandboxRetry(() =>
            touch(() => handle.stopSupervisedProcess(processId)));
          return JSON.stringify({ processId, ...result });
        } catch (err) {
          return refusalText(sandboxFailure({ doing: `sandbox stopProcess ${processId}`, cause: err }));
        }
      },
    },
    listProcesses: {
      description:
        'List sandbox processes as JSON rows {processId,pid,status,restartable,command}. ' +
        '`restartable:true` rows come back after a container restart.',
      execute: async (): Promise<string> => {
        if (!handle) return NOT_CONFIGURED_REFUSAL;
        try {
          const rows = await withSandboxRetry(() => touch(async () => {
            await handle.ensureReady();
            return handle.listSupervisedProcesses();
          }));
          return JSON.stringify(rows);
        } catch (err) {
          return refusalText(sandboxFailure({ doing: 'sandbox listProcesses', cause: err }));
        }
      },
    },
  };

  const types = `
/**
 * sandbox — @cloudflare/sandbox Linux container, one per agent.
 *
 * NOT where the toolchain lives. The workspace executor already has a POSIX
 * shell, ~95 coreutils, node, npm/npx, and git; python3/pip and bash install
 * there on first use. Come here only for what the workspace cannot honour:
 *   - RUNNING a prebuilt native Linux binary (Nimbus is wasm32-wasi and JS),
 *   - real parallelism across cores (Nimbus threads are cooperative), 2 vCPU,
 *   - more than a couple of GB of RAM (this VM reports 6185 MiB / 7.3G total),
 *   - work that must not share the workspace's durable fate.
 * NOT for docker, python3, make, gcc, clang or tsc — probed ABSENT (exit 127)
 * in this image. NOT for inbound ports or long processes: the workspace has
 * both. A cold start costs ~2.8s; concurrency is refused, not queued, at 10
 * instances (503) and on a start-rate burst (429).
 * Full rule: docs/EXECUTION-LAYER-SPEC.md.
 *
 * Every call below either answers, or resolves to a refusal
 * \`{"reason":"<class>","error":"<what happened>"}\`. \`reason\` is the class —
 * bad_input, unavailable, unsupported, timeout, cancelled, oom, io — so branch on
 * it rather than matching prose. \`unavailable\` means this deployment has no
 * container; retrying a different runtime is the move.
 *
 * /workspace is the REAL working directory: every relative path in exec,
 * processes and file calls resolves against it. Absolute paths are welcome.
 *
 * Background servers MUST be started with startProcess — supervision records a
 * restart spec so the process comes back when the container restarts. A bare
 * nohup-and-background job dies with the container and is NOT restorable.
 */
declare namespace sandbox {
  function exec(command: string): Promise<string>;
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<string>;
  function listFiles(path: string): Promise<string>;
  function readdir(path: string): Promise<string>;
  function deleteFile(path: string): Promise<string>;
  /** "true" or "false" — or a refusal payload, if the container could not be asked. */
  function exists(path: string): Promise<string>;
  /** Supervised background process: returns JSON {processId,restartable:true}. */
  function startProcess(command: string, opts?: { cwd?: string }): Promise<string>;
  function stopProcess(processId: string): Promise<string>;
  /** JSON rows {processId,pid,status,restartable,command}. */
  function listProcesses(): Promise<string>;
  function exposePort(port: number, name?: string): Promise<string>;
  function unexposePort(port: number): Promise<string>;
  function listPorts(): Promise<string>;
}
`.trim();

  // What the container image actually holds, probed inside the deployed one
  // rather than read off the SDK's declaration: `executeInExecutor` against the
  // deployed container reports `git` 2.34.1, `npm` 10.9.8, `node` v22.23.2,
  // `bun`, `sh`/`bash`, `jq` and `curl` PRESENT, and `python3`, `python`,
  // `ruby`, `clang`, `gcc`, `make`, `tsc` and `docker` ABSENT at exit 127
  // (docs/EXECUTION-LAYER-SPEC.md; the row in AGENTS.md). A capability the model
  // reads in its execution block ("— runs: …", prompting/volatile-context.ts) is
  // a routing instruction, so an aspirational entry sends work somewhere it
  // cannot be done — and the language rows are the ones it reads. Per entry:
  //
  //   javascript     `node` v22.23.2, and `bun`.
  //   typescript     `bun`, which executes a `.ts` file directly. `tsc` is
  //                  absent and does not bear on it: `tsc` type-checks, it is
  //                  not what runs the code.
  //   native_binary  a real Linux container, and `git`/`node`/`bun`/`jq`/`curl`
  //                  are themselves ELF binaries — one fetched with `curl` runs
  //                  the same way. RUNS them: `gcc`, `clang` and `make` are
  //                  absent, so nothing is COMPILED here.
  //   shell          `sh` and `bash`.
  //   npm, git       both present. They are no longer the reason to come HERE,
  //                  because the Nimbus workspace serves them too (execution/
  //                  nimbus.ts, vfs/workspace-runtimes.ts) — what is still
  //                  exclusive to the container is in the spec above.
  //
  // NOT `python`: `python3` and `python` both exit 127, so the workspace is the
  // only place Python runs at all. NOT `docker`: `docker` and `dockerd` both
  // exit 127 too, and it was declared here once already.
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
    getStatus: () => ({
      configured: connected,
      available: connected,
      active,
      status: connected ? (active ? 'active' : 'idle') : 'not_configured',
      // An available sandbox with previews off carries the preview reason so
      // surfaces that hand out preview URLs can say so before anyone tries.
      ...(connected ? (previews ? {} : { reason: PREVIEWS_NOT_CONFIGURED }) : { reason: NOT_CONFIGURED }),
    }),
    connect: async () => { /* sandbox starts on first RPC */ },
    disconnect: async () => { /* The sandbox DO persists, but its CONTAINER
      filesystem does NOT — the container sleeps after ~10m idle and /workspace
      is lost. Durability is the container DO's own affair: it snapshots
      /workspace to R2 periodically and restores in its container-start hook,
      before any executor can observe the container. Not this no-op close. */ },
    tools,
    types,
    positionalArgs: true,

    // ── Generic ExecutorProvider port surface ────────────────────
    //
    // Mirrors the namespaced `sandbox.exposePort` codemode tool, but at
    // the ExecutorProvider abstraction so any caller can ask any executor
    // to expose a port without knowing it's "sandbox" specifically.
    async exposePort(port, opts) {
      if (!handle) return { supported: false, reason: NOT_CONFIGURED };
      if (!previewHostSuffix) return { supported: false, reason: PREVIEWS_NOT_CONFIGURED };
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        return { supported: false, reason: `invalid port ${port}` };
      }
      // Pre-flight: verify a server is responsive on the port. Without this the
      // caller gets a preview URL that 502s — and a probe that cannot RUN is
      // reported, not stepped over: the shell swallows curl's own failure with
      // `|| true`, leaving only "this container cannot execute a command", and
      // exposing a port on such a container has nothing left to mean.
      const probe = await probeListener(handle, Number(port));
      if ('unprobeable' in probe) {
        return { supported: false, reason: renderThrownChain({ cause: probe.unprobeable }) };
      }
      if (!probe.listening) {
        return {
          supported: false,
          reason:
            `nothing is listening on port ${port} inside the sandbox. ` +
            `Start a SUPERVISED server first — sandbox.startProcess("python3 -m http.server ${port}" +
            " --directory /workspace/<app>") or sandbox.startProcess("node server.js") — ` +
            `then call exposePort again. Supervision survives restarts; nohup does not.`,
        };
      }
      try {
        return {
          supported: true,
          url: await exposeWithDurableToken(handle, previewHostSuffix, port, opts?.name),
          port,
          name: opts?.name,
          // Reached only past the probe above, which is the verification.
          verified_listening: true,
        };
      } catch (err) {
        return { supported: false, reason: renderThrownChain({ cause: err }) };
      }
    },

    async unexposePort(port) {
      if (!handle) return;
      // No catch: the SDK deletes the port token only if it is there, so
      // unexposing an unexposed port already succeeds. What the old
      // `catch { /* idempotent */ }` actually absorbed was an invalid port and
      // a failed storage write — a port left forwardable, reported as removed.
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

/**
 * The container's files, in the container's own absolute paths.
 *
 * Over the raw SDK handle, which has no stat and no mkdir: stat is synthesized
 * from a listing of the parent (size + type; the SDK reports no mtime, so mtime
 * is 0, never invented), and mkdir/exists go through the container's shell.
 * Binary content rides the SDK's base64 encoding both ways — the SDK flags a
 * binary read itself — so bytes round-trip exactly.
 *
 * `readdirStats` exists because that synthesis makes a per-child stat cost a
 * FULL RELISTING of the same directory: a browser listing an N-child folder ran
 * one listing plus N more identical ones. One listing already carries every
 * field the synthesized stat can report, so this hands them back together.
 */
export function sandboxFiles(handle: SandboxHandle): VFS & Pick<VfsNativeReads, 'readdirStats' | 'readRange'> {
  const isDir = (f: { type?: string; isDirectory?: boolean }): boolean =>
    f.isDirectory ?? (f.type === 'directory' || f.type === 'dir');
  const nameOf = (f: { name?: string; path?: string }): string => {
    const p = f.name ?? f.path ?? '';
    return p.slice(p.lastIndexOf('/') + 1);
  };

  return {
    async readFile(path, opts) {
      const r = await handle.readFile(path);
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

    /**
     * A bounded byte window, through the container's own streamed process
     * surface. The SDK's `readFile` has no offset/length and materializes the
     * file; `dd` reads only this range and base64 is the same binary boundary
     * this adapter's whole-file read already uses. Path is shell-quoted, and
     * numeric bounds are validated before becoming command syntax.
     */
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
      if (v.is(v.string(), data)) await handle.writeFile(path, data);
      else await handle.writeFile(path, bytesToBase64(data), { encoding: 'base64' });
    },

    async readdir(path) {
      const r = await handle.listFiles(path, { recursive: false });
      return (r.files ?? []).map(nameOf).filter((n) => n.length > 0);
    },

    async readdirStats(path) {
      const r = await handle.listFiles(path, { recursive: false });
      return (r.files ?? [])
        .map((f) => ({ name: nameOf(f), entry: f }))
        .filter(({ name }) => name.length > 0)
        .map(({ name, entry }) => ({
          name,
          // Every field the synthesized `stat` below can report, off the listing
          // it would have re-run to get them. No mtime here for the same reason
          // there is none there: the SDK reports none, and 0 says so.
          stat: { size: entry.size ?? 0, mtimeMs: 0, isDir: isDir(entry) },
        }));
    },

    async stat(path) {
      const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
      if (clean === '/' || clean === '') return { size: 0, mtimeMs: 0, isDir: true };
      const name = clean.slice(clean.lastIndexOf('/') + 1);
      // Same listing `readdir` above runs uncaught: null is reserved for "the
      // parent has no such entry", so a parent that cannot be listed propagates
      // rather than being reported as a file that simply is not there.
      const files = (await handle.listFiles(vfsDirname(clean), { recursive: false })).files ?? [];
      const entry = files.find((f) => nameOf(f) === name);
      if (!entry) return null;
      return { size: entry.size ?? 0, mtimeMs: 0, isDir: isDir(entry) };
    },

    async unlink(path) { await handle.deleteFile(path); },

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
