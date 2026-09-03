/**
 * DeviceTunnelExecutor — the user's machines via the device-tunnel bridge.
 *
 * The user runs a small daemon on each machine that connects to the agent's
 * WebSocket endpoint through the user-level hub (UserDO). Commands are sent as
 * JSON-RPC over the WebSocket and results stream back.
 *
 * The account is a FLEET: the user may have several machines linked, and
 * several live at once. Two facts follow, and this file is where both land:
 *
 *   1. A command NAMES its machine. Every tool takes an optional `{ device }`
 *      option in the same trailing context that carries the abort signal.
 *      Exactly one live machine answers with no name; more than one refuses
 *      with the classified ask naming them. The hub refuses a call that
 *      crosses to a machine nobody named — the default "first live socket"
 *      is what let two machines take turns answering as one.
 *
 *   2. Files mount per machine. `deviceFleetFiles` is the composite plane:
 *      `/pc` still serves a one-machine account byte-for-byte as before, and
 *      each machine of a fleet appears under `/pc/<name>` by the name every
 *      surface renders. A path that names no live machine refuses with the
 *      connected names — a stated absence, never an empty directory.
 *
 * When no tunnel is connected, all operations return a clear message
 * telling the user how to connect.
 *
 * Namespace: laptop.*
 *   laptop.exec("git status")
 *   laptop.exec("make", { device: "studio" })
 *   laptop.readFile("/Users/me/project/src/main.ts")
 *   laptop.writeFile("/tmp/output.json", data)
 *   laptop.readdir("/Users/me/project")
 *   laptop.exists("/Users/me/.config")
 */

import * as v from 'valibot';
import { isAbortError, raceAbort } from '@kinu.run/agent-utils';
import type { VFS, VfsEntryStat } from '../types/primitives';
import type { VfsNativeReads } from '../vfs/mounts';
import { makeVfsError } from '../vfs/errno';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { formatExecResult, refusalText } from './exec-result';
import { KinuError, renderThrownChain, toKinuError } from '../obs/index';
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
import {
  isJsonObject,
  JsonValueSchema,
  type JsonValue,
} from '../utils/json';

const NOT_CONNECTED =
  'No device connected. Asking for one raised a request with your user: they are shown a card ' +
  'that walks them through linking a machine (Devices / Executors tab, or `kinu connect`). ' +
  'Nothing runs here until they do, so carry on with what does not need their machine.';

/** True by construction rather than by probe — properties of this executor's
 *  own wiring, which no answer from the machine could confirm or deny. Read the
 *  provider below for what each one rests on. */
const STRUCTURAL: readonly ExecutorCapability[] = [
  'native_binary', 'shell', 'fs_owned', 'net_outbound', 'process_spawn',
] as const;

/** What this row can only learn from the machine: everything a PATH lookup
 *  settles, plus the two it cannot settle at all. Both belong here — a
 *  capability nobody can answer for is unmeasured on every row, forever, and
 *  dropping it silently would read as measured absent. */
const ASKED_OF_THE_MACHINE: readonly ExecutorCapability[] = [
  ...TOOLCHAIN_PROBED_CAPABILITIES,
  ...TOOLCHAIN_UNPROBEABLE.map(([capability]) => capability),
];

/**
 * `unavailable` — the user has no machine attached right now, and connecting one
 * is exactly the retry that fixes it. The prose stays verbatim inside the
 * refusal: it names the two places the user connects from, and that instruction is
 * the whole value of the message.
 */
const NOT_CONNECTED_REFUSAL = refusalText(new KinuError('unavailable', NOT_CONNECTED));

/** `io` is this seam's own answer for an unrecognised failure — the transport is a
 *  socket to the user's machine, held by the hub. A cause the classifier does
 *  recognise (an abort, a deadline, an errno the daemon reported) keeps the more
 *  precise code it already carries. */
function deviceFailure(input: { doing: string; cause: unknown }): KinuError {
  return toKinuError({ ...input, otherwise: 'io' });
}

/**
 * What an abort that reached this tool before the frame went out reads as.
 * Nothing was sent, so nothing is running — the one cancellation with no
 * process to account for.
 */
const EXEC_NOT_STARTED =
  'laptop exec stopped before the command was sent — nothing ran on the device';

/** The kernel confirmed the daemon's owned process group is gone. A command
 *  can deliberately create a separate session (`setsid`); the daemon cannot
 *  claim authority over that independently escaped process. */
const EXEC_TERMINATED =
  'laptop exec stopped — the device confirmed its owned command process group terminated; separately sessioned processes may still run';

/** The daemon holds no active command control entry. A terminal shell can have
 *  left backgrounded work in its group, and a command can escape into another
 *  session, so this is availability rather than a claim every process is gone. */
const EXEC_NOTHING_RUNNING =
  'laptop exec stopped — no active command control entry remained on the device; backgrounded or separately sessioned processes may still run';

/** The machine answers device calls but has no cancellation method at all, so
 *  the command outlives the turn. The user has to update the daemon on that
 *  machine before a stop can reach it. */
const EXEC_CANCEL_UNSUPPORTED =
  'laptop exec aborted — this machine runs an older Kinu daemon that cannot stop a command, '
  + 'so the command may still be running. Ask the user to update the daemon on that machine.';

/** The device left while the cancellation was in flight, so nothing confirmed
 *  the kill. The daemon terminates commands it can no longer answer to when its
 *  own socket closes, but this side did not see that happen and will not say it
 *  did. */
const EXEC_CANCEL_UNCONFIRMED =
  'laptop exec aborted — the device disconnected before it confirmed the command stopped';

/** Nothing about the command's fate came back: the kernel refused the kill, the
 *  device never answered inside the transport's deadline, or the answer that
 *  did come back was about some other command. Whatever the reason, this side
 *  cannot say the work ended, and it names why. */
const execCancelFailed = (reason: string): string =>
  `laptop exec aborted — the device could not stop the command, which may still be running: ${reason}`;

/**
 * Stop a command that is already running on the machine, and say what stopping
 * it achieved.
 *
 * This runs on the abort path, where the caller's wait is ending either way and
 * the only open question is whether the process is gone. So it answers instead
 * of throwing, and every branch is a claim the daemon actually supports: a kill
 * the kernel accepted, a request the daemon no longer holds, a daemon too old
 * to be asked, a device that left mid-cancellation, or no confirmed stop at
 * all. Only an answer that NAMES this request confirms anything about it.
 */
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
    if (isDeviceUnknownMethodError(err)) return EXEC_CANCEL_UNSUPPORTED;
    if (isDeviceNotConnectedError(err)) return EXEC_CANCEL_UNCONFIRMED;
    return execCancelFailed(renderThrownChain({ cause: err }));
  }
}

/**
 * Per-call options for one device RPC.
 *
 * `timeoutMs: 0` means the call carries no work deadline — it ends when the
 * device answers, the caller aborts, or the device goes away.
 *
 * `requestId` is the identity to issue the call under, from
 * `nextDeviceRequestId`. A caller that may have to CANCEL the call passes one,
 * because that id is what the daemon registers the command's process group under
 * and the only handle a cancellation carries.
 *
 * `backgroundJobId` names the durable background job that owns the call at the
 * moment it is issued. It exists so a call made AFTER a detach is recorded as
 * that job's from the start, instead of being handed over afterwards by a
 * transfer that races the insert. It never crosses to the device.
 *
 * `deviceId` names the machine the call is FOR. The hub routes on it: a named
 * machine is the only one that answers, and a fleet with several live machines
 * refuses a call that named none — "first live socket" was the two-machines-
 * one-turn flap. The executor resolves the model's device NAME to this id
 * against the fleet snapshot, so the wire carries the stable id and the model
 * speaks the user's name.
 */
export interface DeviceExecOptions {
  timeoutMs?: number;
  requestId?: string;
  backgroundJobId?: string;
  deviceId?: string;
}

/**
 * Transport the laptop executor speaks through. The actual device sockets live
 * on the user-level hub (UserDO); the agent forwards each JSON-RPC call there,
 * so every connected device serves all of a user's agents. `status()` is a cheap
 * CACHED snapshot (the executor's isAvailable()/getStatus() are sync + hot)
 * that the transport refreshes from the hub out of band; `refreshStatus()` is
 * the authoritative awaited check backends run at turn start so the turn's
 * context reflects the CURRENT device state. Tool calls do NOT gate on either —
 * they go to the hub and let it answer authoritatively, so a device that
 * connected after this runtime was built works immediately.
 */
export interface DeviceTransport {
  rpc(method: string, params: JsonValue[], opts?: DeviceExecOptions): Promise<JsonValue | undefined>;
  /** Cached snapshot — sync and cheap; may lag the hub by the cache TTL. */
  status(): DeviceStatus;
  /** Authoritative hub check; resolves with the fresh snapshot. */
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

/**
 * The `{ device }` option, from the same trailing context that carries the
 * abort signal (`readExecSignal` reads its sibling). The schema is a permissive
 * object, not a strict one: a caller that passes `{ signal }` must not have its
 * device option dropped by a shape mismatch on the other field.
 */
const DeviceSelectionSchema = v.union([
  v.string(),
  v.object({ device: v.optional(v.string()) }),
]);

/** The machine the call names, or undefined when it names none — a plain
 *  string or an options object are both accepted, because codemode callers
 *  write `laptop.exec(cmd, 'studio')` and in-process callers write
 *  `execute(cmd, { device: 'studio', signal })`. */
export function readDeviceSelection(input: { context: unknown }): string | undefined {
  const parsed = v.safeParse(DeviceSelectionSchema, input.context);
  if (!parsed.success) return undefined;
  const named = v.is(v.string(), parsed.output) ? parsed.output : parsed.output.device;
  return named?.trim() || undefined;
}

/** What one tool call resolved to: the machine it is for, or the refusal to
 *  answer with. A discriminated value, so the tools branch on the domain and
 *  never on the representation of a string. */
type CallTarget =
  | { readonly kind: 'target'; readonly deviceId: string | undefined }
  | { readonly kind: 'refusal'; readonly text: string };

type CallView =
  | { readonly kind: 'view'; readonly view: DeviceVFS }
  | { readonly kind: 'refusal'; readonly text: string };

/**
 * Create the laptop (`laptop.*`) executor over a device transport. The transport
 * forwards to the user's device hub; this executor just shapes the tool surface.
 */
export function createDeviceTunnelExecutor(
  transport: DeviceTransport,
  /** Path-scope for the file view. Omitted leaves the view unscoped, which is
   *  correct only where the caller has already scoped the transport. */
  consent: DeviceFileConsent = ALWAYS_CONSENTED,
): ExecutorProvider {
  // One name every tool below reaches the machine through, typed by the
  // transport itself so an option the seam gains cannot be dropped here.
  const rpc: DeviceTransport['rpc'] = (method, params, opts) => transport.rpc(method, params, opts);

  // Three-state lifecycle from the hub snapshot: connected, registered-but-
  // offline (the user can reconnect), or no registered device at all. The row
  // carries the machine's own NAME and whether this agent already holds its
  // grant, because "laptop" is an API namespace and no user ever called their
  // computer that.
  const getStatus = (): ExecutorStatus => {
    const s = transport.status();
    const named = s.devices?.find((d) => d.connected) ?? s.devices?.[0];
    const identity: Partial<Pick<ExecutorStatus, 'label' | 'granted' | 'sandbox'>> = {};
    if (named) identity.label = named.name;
    if (s.workspaceGranted !== undefined) identity.granted = s.workspaceGranted;
    // The one row the model reads before it decides where to put work, so it
    // carries what the machine will actually do with a command: the owner's
    // switch, what the machine proved, and this workspace's own home on it.
    if (s.sandbox !== undefined) identity.sandbox = s.sandbox;
    // Reach, not liveness. A connected machine this workspace holds no grant
    // on is not callable by the model: the first call raises the owner's card
    // instead of running. `workspaceGranted` is absent for callers that have
    // no workspace side to their identity, and those keep the row as it was —
    // they were never routing on this field.
    if (s.connected && s.workspaceGranted === false) {
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

  // Derived per read, not frozen at construction: a device that connects — or
  // installs a toolchain onto itself mid-session, which the agent can do through
  // `exec` — must change this row without rebuilding the provider. Memoised on
  // the very answer it was derived from, so repeated reads cost one subtraction.
  let memo: {
    from: DeviceToolchain | null;
    capabilities: ReadonlySet<ExecutorCapability>;
    unmeasured: ReadonlySet<ExecutorCapability>;
  } | null = null;

  const derived = () => {
    const answer = freshDeviceToolchain(transport.status().toolchain, Date.now());
    if (memo?.from === answer) return memo;
    // Anything the answer's own scope covers is measured — named in `present`,
    // or absent because it was looked for and not found. Anything outside that
    // scope was never measured, which includes every entry when there is no
    // answer at all and `docker`/`gpu` even when there is one.
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
      execute: async (...args: unknown[]): Promise<string> => {
        const command = parseInput(StringSchema, { value: args[0] });
        if (command === undefined) {
          return refusalText(new KinuError('bad_input', 'laptop exec: command must be a string'));
        }
        const signal = readExecSignal({ context: args[1] });
        // Which machine this call is FOR. Undefined lets the transport and hub
        // answer the one-machine account exactly as before; a fleet with
        // several live machines refuses there instead of picking one.
        const deviceName = readDeviceSelection({ context: args[1] });
        const device = resolveForCall(transport, deviceName);
        if (device.kind === 'refusal') return device.text;
        const deviceId = device.deviceId;
        // The identity is minted HERE, before the frame goes out, because it is
        // what a cancellation names: the daemon registers this command's
        // process group under it, so an abort can reach the command AND
        // everything it started rather than just ending the wait. The caller
        // learns THIS call's identity, so a detach can hand over exactly this
        // request rather than every device call the turn happens to hold.
        const requestId = nextDeviceRequestId();
        const ownership = readDeviceOwnershipContext({ context: args[1] });
        ownership.report?.(requestId);
        // Read per call, never cached: a scope that has already detached owns
        // this command from the insert, so no handover has to race it.
        const backgroundJobId = ownership.owner?.() ?? null;
        const execOpts: DeviceExecOptions = { timeoutMs: 0, requestId };
        if (deviceId !== undefined) execOpts.deviceId = deviceId;
        if (backgroundJobId !== null) execOpts.backgroundJobId = backgroundJobId;
        try {
          const result = await raceAbort(
            // No transport deadline: this is arbitrary user work — a build, a
            // test suite, an install — and the transport is not the thing that
            // knows how long it should take. The bounds that DO apply stay:
            // the caller's abort signal below, the turn's own cancellation,
            // and the tunnel's liveness probe if the device disappears.
            () => rpc('exec', [command], execOpts),
            signal,
            EXEC_NOT_STARTED,
            () => terminateDeviceExec(rpc, requestId, deviceId),
          );
          const parsed = v.parse(DeviceExecResultSchema, result);
          return formatExecResult(parsed);
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED_REFUSAL;
          // The machine cannot run a command under the tier it was given. That
          // is a REFUSAL with a named cause and a fix, not a transport fault,
          // and the message already reads as one — prefixing it with the
          // command would bury the sentence that says what to do about it.
          if (isSandboxUnavailableError(err)) {
            return refusalText(new KinuError('denied', renderThrownChain({ cause: err })));
          }
          return refusalText(deviceFailure({ doing: `laptop exec \`${command}\``, cause: err }));
        }
      },
    },

    readFile: {
      description: 'Read a file from the user\'s local filesystem via the desktop daemon.',
      execute: async (...args: unknown[]): Promise<string> => {
        const path = parseInput(StringSchema, { value: args[0] });
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'laptop readFile: path must be a string'));
        }
        try {
          const target = filesForCall(transport, consent, readDeviceSelection({ context: args[1] }));
          if (target.kind === 'refusal') return target.text;
          const view = target.view;
          return v.parse(v.string(), await view.readFile(path, { encoding: 'utf8' }));
        } catch (err) {
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED_REFUSAL;
          return refusalText(deviceFailure({ doing: `laptop readFile ${path}`, cause: err }));
        }
      },
    },

    writeFile: {
      description: 'Write content to a file on the user\'s local filesystem via the device tunnel.',
      execute: async (...args: unknown[]): Promise<string> => {
        const path = parseInput(StringSchema, { value: args[0] });
        const content = parseInput(StringSchema, { value: args[1] });
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'laptop writeFile: path must be a string'));
        }
        if (content === undefined) {
          return refusalText(new KinuError('bad_input', 'laptop writeFile: content must be a string'));
        }
        try {
          const target = filesForCall(transport, consent, readDeviceSelection({ context: args[2] }));
          if (target.kind === 'refusal') return target.text;
          const view = target.view;
          await view.writeFile(path, content);
          return `Written ${content.length} bytes to ${path}`;
        } catch (err) {
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED_REFUSAL;
          return refusalText(deviceFailure({ doing: `laptop writeFile ${path}`, cause: err }));
        }
      },
    },

    readdir: {
      description: 'List directory contents on the user\'s local machine.',
      execute: async (...args: unknown[]): Promise<string[] | string> => {
        const path = parseInput(OptionalStringSchema, { value: args[0] });
        if (args[0] !== undefined && path === undefined) {
          return refusalText(new KinuError('bad_input', 'laptop readdir: path must be a string'));
        }
        try {
          const target = filesForCall(transport, consent, readDeviceSelection({ context: args[1] }));
          if (target.kind === 'refusal') return target.text;
          const view = target.view;
          return await view.readdir(path ?? await view.homeDir());
        } catch (err) {
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED_REFUSAL;
          return refusalText(deviceFailure({ doing: `laptop readdir ${path || '/'}`, cause: err }));
        }
      },
    },

    exists: {
      description: 'Check if a path exists on the user\'s local machine.',
      execute: async (...args: unknown[]): Promise<boolean | string> => {
        const path = parseInput(StringSchema, { value: args[0] });
        // Both answers used to be `false`, which claims the path is absent on the
        // user's machine. One call was never made and the other could not reach
        // the device — neither established anything about the path, and the
        // second one swallowed its error to say so.
        if (path === undefined) {
          return refusalText(new KinuError('bad_input', 'laptop exists: path must be a string'));
        }
        try {
          const target = filesForCall(transport, consent, readDeviceSelection({ context: args[1] }));
          if (target.kind === 'refusal') return target.text;
          const view = target.view;
          return await view.exists(path);
        } catch (err) {
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED_REFUSAL;
          return refusalText(deviceFailure({ doing: `laptop exists ${path}`, cause: err }));
        }
      },
    },
  };

  const provider: ExecutorProvider = {
    name: 'laptop',
    files,
    homeDir: files.homeDir,
    kind: 'laptop',
    // The set is rendered into the model's execution block ("— runs: …",
    // prompting/volatile-context.ts), which is where work is routed: a
    // declared-but-absent capability sends work to the user's hardware, behind
    // a consent prompt they granted, and fails there, while a present-but-
    // undeclared one means the work never goes there at all.
    //
    // STRUCTURAL is what the tunnel's existence and this provider's own tools
    // establish, with no probe needed:
    //
    //   shell          `exec` runs the command under `bash -c` on the device.
    //   native_binary  the daemon holding this tunnel open is one, on that
    //                  machine.
    //   fs_owned       the device's real files, behind the consent boundary.
    //   net_outbound   the device dialled this hub to get here.
    //   process_spawn  `exec` can start a child.
    //
    // `net_inbound`, `process_long` and `process_signal` are refuted by this
    // file: `exposePort` below answers `supported: false` because the device is
    // behind the user's NAT, and no tool in the `laptop` namespace can keep or
    // signal a process — the surface is exec, readFile, writeFile, readdir,
    // exists. Refuted, so they are absent rather than unmeasured.
    //
    // Everything else comes from the machine's own answer, carried on the hub
    // snapshot (./device-status). Three states, and the third is load-bearing:
    // an answer that names a capability is evidence FOR it, an answer whose
    // scope covers it and does not name it is evidence AGAINST it, and no
    // machine without python.
    get capabilities() {
      return derived().capabilities;
    },
    get unmeasuredCapabilities() {
      return derived().unmeasured;
    },
    isAvailable: () => transport.status().connected,
    getStatus,
    connect: async () => {
      // Verify connectivity with a simple echo
      try {
        await rpc('exec', ['echo connected']);
      } catch (err) {
        // Classified rather than a bare `Error`, so a caller that catches this
        // lifecycle failure reads the same `unavailable` the tools return.
        if (isDeviceNotConnectedError(err)) throw new KinuError('unavailable', NOT_CONNECTED, { cause: err });
        throw err;
      }
    },
    disconnect: async () => { /* the hub owns the socket lifecycle */ },
    tools,
    types: `/**
 * Every call below either answers, or resolves to a refusal
 * \`{"reason":"<class>","error":"<what happened>"}\`. \`reason\` is the class —
 * bad_input, unavailable, unsupported, timeout, cancelled, oom, io — so branch on
 * it rather than matching prose. \`unavailable\` means no device is attached right
 * now; the error text says how the user attaches one. With several of the user's
 * machines connected, a call that names none refuses asking for one: pass
 * \`{ device: "<name>" }\` — the names are in the execution-status block.
 */
declare namespace laptop {
  /** Execute a command on the user's local machine */
  function exec(command: string, opts?: { device?: string }): Promise<string>;
  /** Read a file from the user's local filesystem */
  function readFile(path: string, opts?: { device?: string }): Promise<string>;
  /** Write a file to the user's local filesystem */
  function writeFile(path: string, content: string, opts?: { device?: string }): Promise<string>;
  /** List directory contents on the user's local machine — or a refusal payload */
  function readdir(path: string, opts?: { device?: string }): Promise<string[] | string>;
  /** true or false — or a refusal payload, if the device could not be asked */
  function exists(path: string, opts?: { device?: string }): Promise<boolean | string>;
}`,
    positionalArgs: true,
    // The user's PC is behind their NAT — we don't open inbound ports
    // back to them. The user can already point their local browser at
    // any URL their machine serves. Use `sandbox` for previewable URLs.
    async exposePort(port: number) {
      return {
        supported: false,
        reason:
          `laptop executor reverse-tunnels outbound from your PC; there's no inbound port to expose ` +
          `from this side. Point your local browser at the address your server uses (port ${port}), ` +
          `or use the 'sandbox' executor if you want a public URL.`,
      };
    },
    async unexposePort() { /* nothing to do */ },
    async listExposedPorts() { return []; },
  };

  return provider;
}

// ── Fleet plumbing ──────────────────────────────────────────────────────────
//
// These live below the factory so the reader meets the tool surface first and
// the machinery after; both are exported because the transport-side tests and
// the composite mount plane build on them.

/**
 * The machine one tool call is FOR, resolved against the fleet snapshot.
 *
 * The snapshot decides two things only: which id a NAME means, and whether an
 * unnamed call is ambiguous. It never gates the call itself — a tool call goes
 * to the hub and lets it answer authoritatively, so a machine that connected
 * after this snapshot was taken works immediately, exactly as before the fleet.
 *
 *   - a named machine the fleet holds → its id;
 *   - a name the fleet does not hold → `unavailable`, naming the live machines;
 *   - no name and several live machines → `bad_input`, the classified ask;
 *   - no name otherwise → the sole live machine's id, or none when the fleet is
 *     unknown or empty here (the hub resolves a one-machine account and refuses
 *     the rest).
 */
function resolveForCall(
  transport: DeviceTransport,
  named: string | undefined,
): CallTarget {
  const fleet = transport.status().devices;
  const live = connectedDevices(fleet);
  const refuse = (error: KinuError): CallTarget => ({ kind: 'refusal', text: refusalText(error) });
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

/**
 * The per-machine file view one tool call reaches, keyed by the same
 * resolution {@link resolveForCall} performs. A refusal string comes back
 * as-is; the tools return it on the string channel.
 */
function filesForCall(
  transport: DeviceTransport,
  consent: DeviceFileConsent,
  named: string | undefined,
): CallView {
  const resolved = resolveForCall(transport, named);
  if (resolved.kind === 'refusal') return resolved;
  return { kind: 'view', view: deviceFiles(transport, consent, resolved.deviceId) };
}

/**
 * Scope of the device file view. The view exposes the device's REAL root — a
 * faithful window, not a lossy rewrite — but only the directory the owner
 * NAMED at `kinu connect` is reachable while the device's Sandbox switch is on.
 *
 * There is deliberately no fallback. The scope used to default to `$HOME`,
 * which holds `~/.kinu/config.json` (the owner's CLI bearer), `~/.ssh` and
 * `~/.aws` — so "inside its connected folder" was the whole home, and reading
 * one file in it escalated what the agent could reach. A device that reported
 * no root has no scoped file access: the owner re-runs `kinu connect` in the
 * directory they mean, which is the only party that can answer that question.
 *
 * `unconfined` is the Sandbox switch, read from the hub. It is one question
 * with one answer for both enforcers: the kernel sandbox the shell runs under,
 * and this path scope. Two switches would let `readFile` and `bash` see
 * different machines, which is the drift the one view exists to prevent.
 */
export interface DeviceFileConsent {
  /** The directory the owner consented, or null when this device reported
   *  none. Async because the answer lives on the device row, not in the
   *  isolate. */
  consentedRoot(): Promise<string | null>;
  /** The machine's own home, as it reported on HELLO, or null. Where the file
   *  view opens when no directory was consented — never a scope. */
  deviceHome(): Promise<string | null>;
  /** Whether the owner turned this device's Sandbox switch off, which lifts
   *  the path scope for the same reason it lifts the shell's. */
  unconfined(): Promise<boolean>;
}

const ALWAYS_CONSENTED: DeviceFileConsent = {
  consentedRoot: async () => '/',
  deviceHome: async () => '/',
  unconfined: async () => true,
};

/** The device file view, plus the one thing only the device can answer. */
export type DeviceVFS = VFS & Pick<ExecutorProvider, 'homeDir'> & Pick<VfsNativeReads, 'readRange'>;

/**
 * The user's machine, in the machine's own absolute paths.
 *
 * The daemon speaks every file operation natively. Each call carries the
 * consented root, which the daemon resolves together with the path before the
 * filesystem sink; this client guard rejects obvious lexical escapes first.
 * Every call still crosses the hub's per-(agent, device) action-consent
 * chokepoint, and this view adds the path-scope layer on top.
 *
 * `homeDir` is where the view opens: the consented root, or the machine's own
 * home under the full tier. Both arrive on `HELLO` and sit on the device row,
 * so this view never runs a command to learn a path — it used to `exec`
 * `printf %s "$HOME"`, which is an exec, which needs the FULL tier, so a
 * base-tier workspace could not list a directory without first being pushed
 * through a full-filesystem consent card.
 */
export function deviceFiles(transport: DeviceTransport, consent: DeviceFileConsent, deviceId?: string): DeviceVFS {
  // Every call of this view is FOR one machine. The hub routes on the id; a
  // view built with none (a one-machine account, or a fleet the snapshot has
  // not described yet) sends no key and lets the hub resolve it.
  const target: DeviceExecOptions | undefined = deviceId === undefined ? undefined : { deviceId };
  const trimmed = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);
  const effectiveRoot = async (): Promise<string> => {
    const explicit = await consent.consentedRoot();
    if (explicit) return trimmed(explicit);
    throw makeVfsError(
      'EACCES',
      'this device reported no consented directory, so the base tier reaches nothing on it — '
      + 'run `kinu connect` on the machine, in the directory this workspace should see',
      '/',
    );
  };
  /** Where the view OPENS, which is not the same question as what it may
   *  reach: the full tier has no root and still needs somewhere to start. */
  const openingDir = async (): Promise<string> => {
    const root = await consent.consentedRoot();
    if (root) return trimmed(root);
    const home = await consent.deviceHome();
    if (home) return trimmed(home);
    throw makeVfsError('EACCES', 'this device reported neither a consented directory nor a home', '/');
  };

  const guard = async (path: string, op: string): Promise<string | null> => {
    if (await consent.unconfined()) return null;
    const root = await effectiveRoot();
    // No fallback: a device that named no directory throws above rather than
    // widening to `/`. The daemon enforces the same view a second time, so
    // this lexical check is the cheap first line, never the boundary.
    if (!(path === root || path.startsWith(`${root}/`))) {
      throw makeVfsError(
        'EACCES',
        `'${path}' is outside the consented device directory '${root}' — `
        + 'the agent sees its own home plus the folders the owner consented, and nothing else. '
        + `Ask the owner to consent that directory, ${op} '${path}'`,
        path,
      );
    }
    // The daemon resolves both root and path through realpath before the sink.
    // That is the authoritative traversal/symlink check; this lexical check
    // rejects obvious escapes before they cross the tunnel.
    return root;
  };

  /** Bytes that survive a utf-8 decode→encode round-trip byte-exactly may ride
   *  the text protocol; anything else must go base64 or it corrupts.
   *
   *  The round trip IS the test, run rather than inferred from a thrown decode:
   *  a non-fatal decode substitutes U+FFFD for every invalid sequence, and
   *  U+FFFD re-encodes to three bytes that cannot match what produced it —
   *  while a genuinely encoded U+FFFD round-trips and is correctly kept. */
  const asLosslessText = (bytes: Uint8Array): string | null => {
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    const encoded = new TextEncoder().encode(text);
    if (encoded.length !== bytes.length) return null;
    for (let i = 0; i < encoded.length; i++) if (encoded[i] !== bytes[i]) return null;
    return text;
  };

  return {
    homeDir: openingDir,
    async readFile(path, opts) {
      const root = await guard(path, 'open');
      const raw = await transport.rpc('readFile', [path, { encoding: 'base64', root }], target);
      if (raw !== undefined && isJsonObject(raw) && raw.encoding === 'base64') {
        const content = v.parse(v.string(), raw.content);
        const bytes = base64ToBytes(content);
        return opts?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      }
      const text = v.parse(v.string(), raw);
      return opts?.encoding === 'utf8' ? text : new TextEncoder().encode(text);
    },

    async readRange(path, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
        throw makeVfsError('EIO', 'range offset and length must be positive safe integers', path);
      }
      const root = await guard(path, 'open');
      const raw = await transport.rpc('readRange', [path, offset, length, { root }], target);
      if (raw === undefined || !isJsonObject(raw) || raw.encoding !== 'base64') {
        throw makeVfsError('EIO', 'device returned an unreadable file range', path);
      }
      return base64ToBytes(v.parse(v.string(), raw.content));
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
      const entries = v.parse(DeviceListResultSchema, await transport.rpc('listFiles', [path, { root }], target));
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

/**
 * The mount-key segment a device's files appear under inside the composite
 * plane: the machine's own name when it is one clean path segment and no other
 * live machine shares it, otherwise its id — the unique key the owner's
 * devices table mints, which no rename or sibling can displace.
 */
export function deviceMountSegment(device: DeviceFleetEntry, fleet: readonly DeviceFleetEntry[] | undefined): string {
  const name = device.name.trim();
  const usable = name.length > 0 && !name.includes('/') && name !== '.' && name !== '..';
  if (!usable) return device.id;
  const others = connectedDevices(fleet).filter((d) => d.id !== device.id && d.name.trim() === name);
  return others.length === 0 ? name : device.id;
}

/** One route of the composite plane: the segment, and the machine it serves. */
interface DeviceRoute {
  readonly segment: string;
  readonly view: DeviceVFS;
}

/**
 * The fleet's composite file plane.
 *
 * A one-machine account keeps the exact shape the mount table has always
 * served: the provider's `files` is THAT machine's view, so `/pc/home/me/x`
 * is the machine's own `/home/me/x` and nothing about existing paths moves.
 * A fleet adds one segment per machine: `/pc/<segment>/...`, where the
 * segment is the machine's name (its id when the name is shared or not a
 * usable path segment). The segment lives beside the name in every surface
 * that renders the fleet, so the model always has the exact bytes to type.
 *
 * A path whose first segment names no live machine refuses with the connected
 * names — the stated absence the mount law requires, never an empty listing
 * that could read as "this machine has no files".
 */
export function deviceFleetFiles(transport: DeviceTransport, consent: DeviceFileConsent): DeviceVFS {
  /** The one view a path reaches WITHOUT a segment: the sole live machine, or
   *  the unnamed view when the fleet is unknown or empty here (the hub then
   *  answers for a one-machine account or refuses, exactly as before). Null
   *  when several machines are live and a segment must choose. */
  const single = (): DeviceVFS | null => {
    const machines = connectedDevices(transport.status().devices);
    return machines.length > 1 ? null : deviceFiles(transport, consent, machines[0]?.id);
  };

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

  const noSuchDevice = (path: string): Error => {
    const fleet = transport.status().devices;
    const first = path.replace(/^\/+/, '').split('/')[0] ?? '';
    const segments = connectedDevices(fleet).map((d) => deviceMountSegment(d, fleet)).join(', ');
    const reason = first === ''
      ? `several machines are connected — each is mounted at /pc/<name>: ${segments}`
      : `no connected machine is named "${first}" — connected: ${segments}`;
    return makeVfsError('ENXIO', reason, `/pc${first === '' ? '' : `/${first}`}`);
  };

  /** One operation, dispatched: straight through on a one-machine plane, by
   *  first segment on a fleet. The fleet's own root ("/") is the machine list,
   *  handled by the callers that can answer it (readdir, stat, exists). */
  const dispatch = async <T>(path: string, op: (view: DeviceVFS, native: string) => Promise<T>): Promise<T> => {
    const one = single();
    if (one) return op(one, path);
    const route = routeOf(path);
    if (!route) throw noSuchDevice(path);
    return op(route.view, route.rest);
  };

  const isFleetRoot = (path: string): boolean =>
    single() === null && (path.replace(/\/+$/, '') === '' || path.replace(/\/+$/, '') === '/');

  return {
    // Where the plane OPENS. A one-machine account opens on that machine's own
    // consented root or home, as it always did; a fleet opens on the machine
    // list at the mount point itself.
    homeDir: async () => {
      const one = single();
      return one ? one.homeDir() : '/';
    },
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
      const one = single();
      if (one) return one.stat(path);
      const route = routeOf(path);
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
      const one = single();
      if (one) return one.exists(path);
      const route = routeOf(path);
      return route ? route.view.exists(route.rest) : false;
    },
  };
}
