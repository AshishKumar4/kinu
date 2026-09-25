/**
 * DeviceTunnelExecutor (`device.*`): the user's machines via a daemon connected through the UserDO hub.
 * A fleet: with several live machines a call must name one (`{ device }`); files mount per machine under `/pc/<name>`.
 */

import * as v from 'valibot';
import { isAbortError, raceAbort } from '@kinu.run/agent-utils';
import type { VFS, VfsEntryStat } from '../types/primitives';
import type { VfsNativeReads } from '../vfs/mounts';
import { makeVfsError } from '../vfs/errno';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { commandResult, type CommandResult } from './exec-result';
import { KinuError, refusalOf, renderThrownChain, toKinuError, type Refusal } from '../obs/index';
import type { ExecutorProvider, ExecutorCapability, ExecutorStatus } from './types';
import {
  connectedDevices, deviceFleetAsk, deviceByName, freshDeviceToolchain,
  type DeviceFleetEntry, type DeviceStatus, type DeviceToolchain,
} from './device-status';
import {
  TOOLCHAIN_PROBED_CAPABILITIES, TOOLCHAIN_UNPROBEABLE,
} from './toolchain';
import {
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_PROTOCOL, parseDeviceCancelAnswer,
  isDeviceNotConnectedError, isDeviceUnknownMethodError, isSandboxUnavailableError,
  nextDeviceRequestId,
} from './device-tunnel';
import { readDeviceOwnershipContext, readExecSignal } from './signal';
import { RESERVED_REFERENCE_ROOTS } from '../vfs/mounts';
import {
  isJsonObject,
  JsonValueSchema,
  type JsonValue,
} from '../utils/json';

const NOT_CONNECTED =
  'No device connected. Asking for one raised a request with your user: they are shown a card ' +
  'that walks them through linking a machine (Devices / Executors tab, or `kinu connect`). ' +
  'Nothing runs here until they do, so carry on with what does not need their machine.';

/** True by this executor's wiring; the machine cannot confirm or deny them. */
const STRUCTURAL: readonly ExecutorCapability[] = [
  'native_binary', 'shell', 'fs_owned', 'net_outbound', 'process_spawn',
] as const;

/** Only the machine can answer these; two are always unmeasured, never silently absent. */
const ASKED_OF_THE_MACHINE: readonly ExecutorCapability[] = [
  ...TOOLCHAIN_PROBED_CAPABILITIES,
  ...TOOLCHAIN_UNPROBEABLE.map(([capability]) => capability),
];

/** No machine attached. The prose names where the user connects from; keep it verbatim in the refusal, built per call. */
const notConnected = (): Refusal => refusalOf(new KinuError('unavailable', NOT_CONNECTED));

/** Fallback code for an unrecognised failure; a classified cause keeps its more precise code. */
function deviceFailure(input: { doing: string; cause: unknown }): KinuError {
  return toKinuError({ ...input, otherwise: 'io' });
}

/** Abort before the frame went out: nothing was sent, so nothing is running. */
const EXEC_NOT_STARTED =
  'device exec stopped before the command was sent — nothing ran on the device';

/** The daemon's owned process group is gone; a `setsid`-escaped process is outside its authority. */
const EXEC_TERMINATED =
  'device exec stopped — the device confirmed its owned command process group terminated; separately sessioned processes may still run';

/** No active command entry on the daemon; backgrounded or escaped work may remain. */
const EXEC_NOTHING_RUNNING =
  'device exec stopped — no active command control entry remained on the device; backgrounded or separately sessioned processes may still run';

/** The daemon has no cancellation method; the user must update it. */
const EXEC_CANCEL_UNSUPPORTED =
  'device exec aborted — this machine runs an older Kinu daemon that cannot stop a command, '
  + 'so the command may still be running. Ask the user to update the daemon on that machine.';

/** The device left mid-cancellation, so nothing confirmed the kill. */
const EXEC_CANCEL_UNCONFIRMED =
  'device exec aborted — the device disconnected before it confirmed the command stopped';

/** Kill refused, no answer within the deadline, or an answer about another command. */
const execCancelFailed = (reason: string): string =>
  `device exec aborted — the device could not stop the command, which may still be running: ${reason}`;

/** Stops a running command and reports what that achieved; answers instead of throwing (abort path).
 *  Only an answer naming this request confirms anything. */
async function terminateDeviceExec(
  rpc: DeviceTransport['rpc'],
  requestId: string,
  deviceId?: string,
): Promise<string> {
  try {
    const answer = parseDeviceCancelAnswer(requestId, await rpc(
      DEVICE_CANCEL_METHOD, [requestId, DEVICE_CANCEL_PROTOCOL], deviceId === undefined ? undefined : { deviceId },
    ));

    return answer.cancelled === 'terminated' ? EXEC_TERMINATED : EXEC_NOTHING_RUNNING;
  } catch (err) {
    if (isDeviceUnknownMethodError({ cause: err })) return EXEC_CANCEL_UNSUPPORTED;

    if (isDeviceNotConnectedError({ cause: err })) return EXEC_CANCEL_UNCONFIRMED;

    return execCancelFailed(renderThrownChain({ cause: err }));
  }
}

/**
 * `timeoutMs: 0`: no work deadline. `requestId`: the id the daemon registers the process group under; needed to cancel.
 * `backgroundJobId`: owning background job at issue time (never sent to the device). `deviceId`: the hub routes on it.
 */
export interface DeviceExecOptions {
  timeoutMs?: number;
  requestId?: string;
  backgroundJobId?: string;
  deviceId?: string;
}

/** Transport to the UserDO hub. `status()` is a cached snapshot; `refreshStatus()` is authoritative (turn start).
 *  Tool calls gate on neither: the hub answers. */
export interface DeviceTransport {
  rpc(method: string, params: JsonValue[], opts?: DeviceExecOptions): Promise<JsonValue | undefined>;
  /** Cached snapshot; may lag the hub by the cache TTL. */
  status(): DeviceStatus;
  refreshStatus(): Promise<DeviceStatus>;
}

const StringSchema = v.string();

const OptionalStringSchema = v.optional(v.string());

const DeviceExecResultSchema = v.object({
  stdout: v.string(),
  stderr: v.string(),
  exitCode: v.number(),
});

const DeviceListResultSchema = v.array(JsonValueSchema);

/** A daemon from before paging answers one array. */
const DeviceListPageSchema = v.union([
  DeviceListResultSchema,
  v.object({ entries: DeviceListResultSchema, next: v.nullable(v.number()) }),
]);

/** Under the 32 MiB a Worker receives per WebSocket message or RPC, even as base64 in JSON. */
const DEVICE_READ_CHUNK_BYTES = 8 * 1024 * 1024;

/** 10,000 names at NAME_MAX still fit one answer. */
const DEVICE_LIST_PAGE_ENTRIES = 10_000;

const DeviceStatSchema = v.nullable(v.object({
  size: v.number(),
  mtimeMs: v.number(),
  isDir: v.boolean(),
}));

function parseInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: { value: unknown },
): v.InferOutput<TSchema> | undefined {
  const result = v.safeParse(schema, input.value);

  return result.success ? result.output : undefined;
}

/** Permissive, so a `{ signal }`-only caller keeps its device option. */
const DeviceSelectionSchema = v.union([
  v.string(),
  v.object({ device: v.optional(v.string()) }),
]);

/** Accepts a string (`device.exec(cmd, 'studio')`) or an options object (`{ device, signal }`). */
function readDeviceSelection(input: { context: unknown }): string | undefined {
  const parsed = v.safeParse(DeviceSelectionSchema, input.context);

  if (!parsed.success) return undefined;
  const named = v.is(v.string(), parsed.output) ? parsed.output : parsed.output.device;
  const trimmed = named?.trim();

  if (trimmed === undefined || trimmed === '') return undefined;

  return trimmed;
}

type CallTarget =
  | { readonly kind: 'target'; readonly deviceId: string | undefined }
  | { readonly kind: 'refusal'; readonly refusal: Refusal };

type CallView =
  | { readonly kind: 'view'; readonly view: DeviceVFS }
  | { readonly kind: 'refusal'; readonly refusal: Refusal };

export function createDeviceTunnelExecutor(
  transport: DeviceTransport,
  /** Path-scope for the file view; omit only where the transport is already scoped. */
  consent: DeviceFileConsent = ALWAYS_CONSENTED,
): ExecutorProvider {
  const rpc: DeviceTransport['rpc'] = (method, params, opts) => transport.rpc(method, params, opts);

  // Connected, registered-but-offline, or none. The row carries the machine's name and grant state.
  const getStatus = (): ExecutorStatus => {
    const s = transport.status();
    const live = (s.devices ?? []).filter((d) => d.connected);
    const named = live[0] ?? s.devices?.[0];
    const identity: Partial<Pick<ExecutorStatus, 'label' | 'granted' | 'sandbox'>> = {};

    if (named) identity.label = named.name;
    // Per-device answers count only when exactly one machine is live.
    const perDeviceReach = live.length === 1 ? live[0].granted : undefined;
    const granted = perDeviceReach ?? s.workspaceGranted;

    if (granted !== undefined) identity.granted = granted;

    if (s.sandbox !== undefined) identity.sandbox = s.sandbox;

    // Reach, not liveness: a machine without this workspace's grant raises the owner's card first.
    if (s.connected && granted === false) {
      return {
        configured: true, available: false, active: false, status: 'idle',
        reason: 'Connected, but this workspace has no access yet: the first command raises a consent card for the owner.',
        ...identity,
      };
    }

    if (s.connected) return { configured: true, available: true, active: true, status: 'active', ...identity };

    if (s.registered) {
      return {
        configured: true, available: false, active: false, status: 'disconnected',
        reason: 'Device registered but offline — the user can reconnect it with `kinu connect`.',
        ...identity,
      };
    }

    return { configured: false, available: false, active: false, status: 'not_configured', ...identity };
  };

  // Derived per read: a device can install a toolchain mid-session.
  let memo: {
    from: DeviceToolchain | null;
    capabilities: ReadonlySet<ExecutorCapability>;
    unmeasured: ReadonlySet<ExecutorCapability>;
  } | null = null;

  const derived = () => {
    const answer = freshDeviceToolchain(transport.status().toolchain, Date.now());

    if (memo?.from === answer) return memo;
    // Inside the answer's scope: measured. Outside it, and `docker`/`gpu` always: unmeasured.
    const measured = answer?.asked ?? [];
    memo = {
      from: answer,
      capabilities: new Set([...STRUCTURAL, ...answer?.present ?? []]),
      unmeasured: new Set(ASKED_OF_THE_MACHINE.filter((c) => !measured.includes(c))),
    };

    return memo;
  };

  const files = deviceFleetFiles(transport, consent);

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Execute a command on the user\'s local machine via the device tunnel.',
      execute: async (...args: unknown[]): Promise<CommandResult> => {
        const command = parseInput(StringSchema, { value: args[0] });

        if (command === undefined) {
          return refusalOf(new KinuError('bad_input', 'device exec: command must be a string'));
        }

        const signal = readExecSignal({ context: args[1] });
        // Undefined lets the hub resolve a one-machine account; several live machines refuse there.
        const deviceName = readDeviceSelection({ context: args[1] });
        const device = resolveForCall(transport, deviceName);

        if (device.kind === 'refusal') return device.refusal;
        const deviceId = device.deviceId;
        // Minted before sending, so a cancel or detach can name the process group.
        const requestId = nextDeviceRequestId();
        const ownership = readDeviceOwnershipContext({ context: args[1] });
        ownership.report?.(requestId);
        // Read per call: a detached scope owns this command from the insert.
        const backgroundJobId = ownership.owner?.() ?? null;
        const execOpts: DeviceExecOptions = { timeoutMs: 0, requestId };

        if (deviceId !== undefined) execOpts.deviceId = deviceId;

        if (backgroundJobId !== null) execOpts.backgroundJobId = backgroundJobId;

        try {
          const result = await raceAbort(
            // No transport deadline: abort, turn cancellation and tunnel liveness still bound it.
            () => rpc('exec', [command], execOpts),
            signal,
            EXEC_NOT_STARTED,
            () => terminateDeviceExec(rpc, requestId, deviceId),
          );

          const parsed = v.parse(DeviceExecResultSchema, result);

          return commandResult(parsed);
        } catch (err) {
          if (isAbortError(err)) throw err;

          if (isDeviceNotConnectedError({ cause: err })) return notConnected();

          // Tier refusal with a named fix, not a transport fault; not prefixed with the command.
          if (isSandboxUnavailableError({ cause: err })) {
            return refusalOf(new KinuError('denied', renderThrownChain({ cause: err })));
          }

          return refusalOf(deviceFailure({ doing: `device exec \`${command}\``, cause: err }));
        }
      },
    },

    readFile: {
      planAllowed: true,
      description: 'Read a file from the user\'s local filesystem via the desktop daemon.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        const path = parseInput(StringSchema, { value: args[0] });

        if (path === undefined) {
          return refusalOf(new KinuError('bad_input', 'device readFile: path must be a string'));
        }

        try {
          const target = filesForCall(transport, consent, readDeviceSelection({ context: args[1] }));

          if (target.kind === 'refusal') return target.refusal;
          const view = target.view;

          return v.parse(v.string(), await view.readFile(path, { encoding: 'utf8' }));
        } catch (err) {
          if (isDeviceNotConnectedError({ cause: err })) return notConnected();

          return refusalOf(deviceFailure({ doing: `device readFile ${path}`, cause: err }));
        }
      },
    },

    writeFile: {
      description: 'Write content to a file on the user\'s local filesystem via the device tunnel.',
      execute: async (...args: unknown[]): Promise<string | Refusal> => {
        const path = parseInput(StringSchema, { value: args[0] });
        const content = parseInput(StringSchema, { value: args[1] });

        if (path === undefined) {
          return refusalOf(new KinuError('bad_input', 'device writeFile: path must be a string'));
        }

        if (content === undefined) {
          return refusalOf(new KinuError('bad_input', 'device writeFile: content must be a string'));
        }

        try {
          const target = filesForCall(transport, consent, readDeviceSelection({ context: args[2] }));

          if (target.kind === 'refusal') return target.refusal;
          const view = target.view;
          await view.writeFile(path, content);

          return `Written ${content.length} bytes to ${path}`;
        } catch (err) {
          if (isDeviceNotConnectedError({ cause: err })) return notConnected();

          return refusalOf(deviceFailure({ doing: `device writeFile ${path}`, cause: err }));
        }
      },
    },

    readdir: {
      planAllowed: true,
      description: 'List directory contents on the user\'s local machine.',
      execute: async (...args: unknown[]): Promise<string[] | Refusal> => {
        const path = parseInput(OptionalStringSchema, { value: args[0] });

        if (args[0] !== undefined && path === undefined) {
          return refusalOf(new KinuError('bad_input', 'device readdir: path must be a string'));
        }

        try {
          const target = filesForCall(transport, consent, readDeviceSelection({ context: args[1] }));

          if (target.kind === 'refusal') return target.refusal;
          const view = target.view;

          return await view.readdir(path ?? await view.homeDir());
        } catch (err) {
          if (isDeviceNotConnectedError({ cause: err })) return notConnected();

          return refusalOf(deviceFailure({ doing: `device readdir ${path ?? '/'}`, cause: err }));
        }
      },
    },

    exists: {
      planAllowed: true,
      description: 'Check if a path exists on the user\'s local machine.',
      execute: async (...args: unknown[]): Promise<boolean | Refusal> => {
        const path = parseInput(StringSchema, { value: args[0] });

        // Never `false` here: that would claim the path is absent on the machine.
        if (path === undefined) {
          return refusalOf(new KinuError('bad_input', 'device exists: path must be a string'));
        }

        try {
          const target = filesForCall(transport, consent, readDeviceSelection({ context: args[1] }));

          if (target.kind === 'refusal') return target.refusal;
          const view = target.view;

          return await view.exists(path);
        } catch (err) {
          if (isDeviceNotConnectedError({ cause: err })) return notConnected();

          return refusalOf(deviceFailure({ doing: `device exists ${path}`, cause: err }));
        }
      },
    },
  };

  const provider: ExecutorProvider = {
    name: 'device',
    files,
    // The fleet plane opens at the roster; a named machine opens at its own dir.
    homeDir: async (segment?: string) => {
      if (segment === undefined) return '/';
      const fleet = transport.status().devices;
      const named = connectedDevices(fleet).find((device) => deviceMountSegment(device, fleet) === segment);

      if (named === undefined) throw noSuchDevice(fleet, segment);

      return deviceFiles(transport, consent, named.id).homeDir();
    },
    kind: 'device',
    filesOwner: 'user',
    // Rendered into the execution block (prompting/volatile-context.ts), which routes work. Structural: shell,
    // native_binary, fs_owned, net_outbound, process_spawn. Refuted: net_inbound, process_long, process_signal.
    get capabilities() {
      return derived().capabilities;
    },
    get unmeasuredCapabilities() {
      return derived().unmeasured;
    },
    isAvailable: () => transport.status().connected,
    getStatus,
    connect: async () => {
      try {
        await rpc('exec', ['echo connected']);
      } catch (err) {
        // Classified so callers read the same `unavailable` the tools return.
        if (isDeviceNotConnectedError({ cause: err })) throw new KinuError('unavailable', NOT_CONNECTED, { cause: err });
        throw err;
      }
    },
    disconnect: async () => { /* the hub owns the socket lifecycle */ },
    tools,
    types: `/**
 * The user's own machine; \`unavailable\` means none is attached, and the error says how to attach one.
 * With several machines connected, name one with \`{ device: "<name>" }\`.
 */
declare namespace device {
  function exec(command: string, opts?: { device?: string }): Promise<string | Refusal>;
  function readFile(path: string, opts?: { device?: string }): Promise<string | Refusal>;
  function writeFile(path: string, content: string, opts?: { device?: string }): Promise<string | Refusal>;
  function readdir(path: string, opts?: { device?: string }): Promise<string[] | Refusal>;
  function exists(path: string, opts?: { device?: string }): Promise<boolean | Refusal>;
}`,
    positionalArgs: true,
    // The PC is behind the user's NAT; no inbound ports. Use `sandbox` for previewable URLs.
    async exposePort(port: number) {
      return {
        supported: false,
        reason:
          `device executor reverse-tunnels outbound from your PC; there's no inbound port to expose ` +
          `from this side. Point your local browser at the address your server uses (port ${port}), ` +
          `or use the 'sandbox' executor if you want a public URL.`,
      };
    },
    async unexposePort() { /* nothing to do */ },
    async listExposedPorts() { return []; },
  };

  return provider;
}

/**
 * Resolves the machine a call is for. Named and held → id; named but not held → `unavailable`; unnamed with several
 * live → `bad_input`; otherwise the sole live id or none (hub resolves). The snapshot never gates the call itself.
 */
function resolveForCall(
  transport: DeviceTransport,
  named: string | undefined,
): CallTarget {
  const fleet = transport.status().devices;
  const live = connectedDevices(fleet);
  const refuse = (error: KinuError): CallTarget => ({ kind: 'refusal', refusal: refusalOf(error) });

  if (named === undefined) {
    if (live.length > 1) return refuse(new KinuError('bad_input', deviceFleetAsk(fleet)));

    return { kind: 'target', deviceId: live[0]?.id };
  }

  if (fleet === undefined) {
    return refuse(new KinuError('unavailable',
      `the device list is not known here yet, so "${named}" cannot be matched — retry, or call without a device`));
  }

  const entry = deviceByName(fleet, named);

  if (entry) return { kind: 'target', deviceId: entry.id };

  return refuse(new KinuError('unavailable',
    `no connected machine is named "${named}" — connected: ${live.map((d) => d.name).join(', ') || 'none'}`));
}

/** Per-machine file view for one call, or the refusal naming why there is none. */
function filesForCall(
  transport: DeviceTransport,
  consent: DeviceFileConsent,
  named: string | undefined,
): CallView {
  const resolved = resolveForCall(transport, named);

  if (resolved.kind === 'refusal') return resolved;

  return { kind: 'view', view: deviceFiles(transport, consent, resolved.deviceId) };
}

/** A device file view's reach: `unconfined` (Sandbox off), `sandboxed` (the consented directory and the agent's own
 *  tmp, which the daemon maps `/tmp` and `/var/tmp` to), `root` (the consented directory). Never `$HOME`. */
export type DeviceFileScope = 'unconfined' | 'sandboxed' | 'root';

export interface DeviceFileConsent {
  /** Consented directory on the named machine, or null when it reported none. */
  consentedRoot(deviceId?: string): Promise<string | null>;
  /** That machine's HELLO-reported home, or null. Where the view opens without a consented dir; never a scope. */
  deviceHome(deviceId?: string): Promise<string | null>;
  scope(deviceId?: string): Promise<DeviceFileScope>;
}

const ALWAYS_CONSENTED: DeviceFileConsent = {
  consentedRoot: async () => '/',
  deviceHome: async () => '/',
  scope: async () => 'unconfined',
};

const AGENT_TMP_PATHS = ['/tmp', '/var/tmp'] as const;

export type DeviceVFS = VFS & Pick<ExecutorProvider, 'homeDir'> & Pick<VfsNativeReads, 'readRange'>;

/**
 * The machine's filesystem in its own absolute paths. The daemon resolves root and path before the sink; this client
 * guard only rejects lexical escapes. `homeDir` comes from HELLO, never an `exec` (which needs the full tier).
 */
export function deviceFiles(transport: DeviceTransport, consent: DeviceFileConsent, deviceId?: string): DeviceVFS {
  // No id (one-machine account or undescribed fleet): send no key and let the hub resolve.
  const target: DeviceExecOptions | undefined = deviceId === undefined ? undefined : { deviceId };
  const trimmed = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

  const effectiveRoot = async (): Promise<string> => {
    const explicit = await consent.consentedRoot(deviceId);

    if (explicit) return trimmed(explicit);
    throw makeVfsError(
      'EACCES',
      'this device reported no consented directory, so the base tier reaches nothing on it — '
      + 'run `kinu connect` on the machine, in the directory this workspace should see',
      '/',
    );
  };

  /** Where the view opens, distinct from its reach: the full tier has no root. */
  const openingDir = async (): Promise<string> => {
    const root = await consent.consentedRoot(deviceId);

    if (root) return trimmed(root);
    const home = await consent.deviceHome(deviceId);

    if (home) return trimmed(home);
    throw makeVfsError('EACCES', 'this device reported neither a consented directory nor a home', '/');
  };

  const guard = async (path: string, op: string): Promise<string | null> => {
    const scope = await consent.scope(deviceId);

    if (scope === 'unconfined') return null;

    if (scope === 'sandboxed' && AGENT_TMP_PATHS.some((tmp) => path === tmp || path.startsWith(`${tmp}/`))) return null;
    const root = await effectiveRoot();

    // A device that named no directory threw above rather than widening to `/`.
    if (!(path === root || path.startsWith(`${root}/`))) {
      throw makeVfsError(
        'EACCES',
        `'${path}' is outside the consented device directory '${root}' — the agent sees the folder the owner `
        + `consented${scope === 'sandboxed' ? ' and its own /tmp' : ''}, and nothing else. `
        + `Ask the owner to consent that directory, ${op} '${path}'`,
        path,
      );
    }

    // The daemon's realpath check is authoritative; this lexical check is a cheap first line.
    return root;
  };

  /** Bytes that survive a utf-8 round-trip byte-exactly may use the text protocol; others go base64.
   *  Tested by round trip because a non-fatal decode substitutes U+FFFD. */
  const asLosslessText = (bytes: Uint8Array): string | null => {
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    const encoded = new TextEncoder().encode(text);

    if (encoded.length !== bytes.length) return null;

    for (let i = 0; i < encoded.length; i++) if (encoded[i] !== bytes[i]) return null;

    return text;
  };

  const readChunked = async (path: string, root: string | null, offset: number, length: number | null): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
      const asked = length === null ? DEVICE_READ_CHUNK_BYTES : Math.min(DEVICE_READ_CHUNK_BYTES, length - total);
      const raw = await transport.rpc('readRange', [path, offset + total, asked, { root }], target);

      if (raw === undefined || !isJsonObject(raw) || raw.encoding !== 'base64') {
        throw makeVfsError('EIO', 'device returned an unreadable file range', path);
      }

      const chunk = base64ToBytes(v.parse(v.string(), raw.content));
      chunks.push(chunk);
      total += chunk.length;

      if (chunk.length < asked || total === length) break;
    }

    if (chunks.length === 1) return chunks[0];
    const bytes = new Uint8Array(total);
    let at = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }

    return bytes;
  };

  return {
    homeDir: openingDir,
    async readFile(path, opts) {
      const bytes = await readChunked(path, await guard(path, 'open'), 0, null);

      return opts?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
    },

    async readRange(path, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
        throw makeVfsError('EIO', 'range offset and length must be positive safe integers', path);
      }

      return readChunked(path, await guard(path, 'open'), offset, length);
    },

    async writeFile(path, data) {
      const root = await guard(path, 'open');
      let result: JsonValue | undefined;

      if (v.is(v.string(), data)) {
        result = await transport.rpc('writeFile', [path, data, { root }], target);
      } else {
        const text = asLosslessText(data);
        result = text !== null
          ? await transport.rpc('writeFile', [path, text, { root }], target)
          : await transport.rpc('writeFile', [path, bytesToBase64(data), { encoding: 'base64', root }], target);
      }

      const ok = result === 'ok'
        || (result !== undefined && isJsonObject(result) && result.success === true);

      if (!ok) throw new Error(`writeFile failed on the device: ${JSON.stringify(result)}`);
    },

    async readdir(path) {
      const root = await guard(path, 'scandir');
      const entries: JsonValue[] = [];

      for (let offset: number | null = 0; offset !== null;) {
        const page: v.InferOutput<typeof DeviceListPageSchema> = v.parse(DeviceListPageSchema, await transport.rpc(
          'listFiles', [path, { root, offset, limit: DEVICE_LIST_PAGE_ENTRIES }], target,
        ));

        if (Array.isArray(page)) {
          entries.push(...page);
          offset = null;
        } else {
          entries.push(...page.entries);
          offset = page.next;
        }
      }

      return entries.map((entry) => {
        if (isJsonObject(entry)) {
          const name = v.safeParse(v.string(), entry.name);

          if (name.success) return name.output;
        }

        return JSON.stringify(entry);
      });
    },

    async stat(path) {
      const root = await guard(path, 'stat');

      return v.parse(DeviceStatSchema, await transport.rpc('statPath', [path, { root }], target));
    },

    async unlink(path) {
      const root = await guard(path, 'unlink');
      await transport.rpc('unlinkPath', [path, { root }], target);
    },

    async mkdir(path, opts) {
      const root = await guard(path, 'mkdir');
      await transport.rpc('mkdirPath', [path, { root, recursive: opts?.recursive ?? false }], target);
    },

    async exists(path) {
      const root = await guard(path, 'stat');

      return v.parse(v.boolean(), await transport.rpc('exists', [path, { root }], target));
    },
  };
}

/** Mount segment: the machine name when it is a clean, unshared segment, else its id. */
export function deviceMountSegment(device: DeviceFleetEntry, fleet: readonly DeviceFleetEntry[] | undefined): string {
  const name = device.name.trim();
  // Reserved reference roots (`vfs`, `sandbox`, `local`) are never a machine's segment.
  const usable = name.length > 0 && !name.includes('/') && name !== '.' && name !== '..' && !RESERVED_REFERENCE_ROOTS.includes(name);

  if (!usable) return device.id;
  const others = connectedDevices(fleet).filter((d) => d.id !== device.id && d.name.trim() === name);

  return others.length === 0 ? name : device.id;
}

/** Stated absence for a path under no live machine, listing the connected segments. */
function noSuchDevice(fleet: readonly DeviceFleetEntry[] | undefined, first: string): Error {
  const segments = connectedDevices(fleet).map((d) => deviceMountSegment(d, fleet)).join(', ');

  const reason = first === ''
    ? `several machines are connected — each is mounted at /pc/<name>: ${segments}`
    : `no connected machine is named "${first}" — connected: ${segments}`;

  return makeVfsError('ENXIO', reason, `/pc${first === '' ? '' : `/${first}`}`);
}

interface DeviceRoute {
  readonly segment: string;
  readonly view: DeviceVFS;
}

/**
 * Fleet composite file plane: `/pc/<segment>/...` is that machine's `/...`, fleet of one included, so paths survive a
 * second machine joining. Unknown segment refuses with the connected names, never an empty listing.
 */
function deviceFleetFiles(transport: DeviceTransport, consent: DeviceFileConsent): DeviceVFS {
  const routes = (): DeviceRoute[] => {
    const fleet = transport.status().devices;

    return connectedDevices(fleet).map((device) => ({
      segment: deviceMountSegment(device, fleet),
      view: deviceFiles(transport, consent, device.id),
    }));
  };

  const routeOf = (path: string): { view: DeviceVFS; rest: string } | null => {
    const trimmed = path.replace(/^\/+/, '');

    if (trimmed === '') return null;
    const slash = trimmed.indexOf('/');
    const first = slash === -1 ? trimmed : trimmed.slice(0, slash);
    const rest = slash === -1 ? '/' : trimmed.slice(slash);
    const route = routes().find((r) => r.segment === first);

    return route ? { view: route.view, rest } : null;
  };


  /** Dispatches by first segment. Root "/" is handled by readdir/stat/exists. Without a fleet snapshot the unnamed view
   *  goes to the hub. */
  const dispatch = async <T>(path: string, op: (view: DeviceVFS, native: string) => Promise<T>): Promise<T> => {
    if (connectedDevices(transport.status().devices).length === 0) {
      return op(deviceFiles(transport, consent, undefined), path);
    }

    const route = routeOf(path);

    if (!route) throw noSuchDevice(transport.status().devices, path.replace(/^\/+/, '').split('/')[0] ?? '');

    return op(route.view, route.rest);
  };

  const isFleetRoot = (path: string): boolean =>
    (path.replace(/\/+$/, '') === '' || path.replace(/\/+$/, '') === '/');

  return {
    // The mount root is a roster, not a directory, so it cannot be a working directory.
    homeDir: async () => '/',
    async readFile(path, opts) {
      return dispatch(path, (view, native) => view.readFile(native, opts));
    },
    async readRange(path, offset, length) {
      return dispatch(path, (view, native) => view.readRange(native, offset, length));
    },
    async writeFile(path, data) {
      await dispatch(path, (view, native) => view.writeFile(native, data));
    },
    async readdir(path) {
      if (isFleetRoot(path)) return routes().map((route) => route.segment);

      return dispatch(path, (view, native) => view.readdir(native));
    },
    async stat(path): Promise<VfsEntryStat | null> {
      if (isFleetRoot(path)) return { size: 0, mtimeMs: 0, isDir: true };

      if (connectedDevices(transport.status().devices).length === 0) {
        return deviceFiles(transport, consent, undefined).stat(path);
      }

      const route = routeOf(path);

      // Answered here so listing /pc never asks a machine to stat a `/` its consent boundary refuses.
      if (route?.rest === '/') return { size: 0, mtimeMs: 0, isDir: true };

      return route ? route.view.stat(route.rest) : null;
    },
    async unlink(path) {
      await dispatch(path, (view, native) => view.unlink(native));
    },
    async mkdir(path, opts) {
      await dispatch(path, (view, native) => view.mkdir(native, opts));
    },
    async exists(path) {
      if (isFleetRoot(path)) return true;

      if (connectedDevices(transport.status().devices).length === 0) {
        return deviceFiles(transport, consent, undefined).exists(path);
      }

      const route = routeOf(path);

      if (route?.rest === '/') return true;

      return route ? route.view.exists(route.rest) : false;
    },
  };
}
