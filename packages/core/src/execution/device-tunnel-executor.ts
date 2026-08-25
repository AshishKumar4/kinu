/**
 * DeviceTunnelExecutor — user's personal machine via WebSocket bridge.
 *
 * The user runs a small daemon on their machine that connects to the
 * agent's WebSocket endpoint. Commands are sent as JSON-RPC over the
 * WebSocket and results stream back.
 *
 * When no tunnel is connected, all operations return a clear message
 * telling the user how to connect.
 *
 * Namespace: laptop.*
 *   laptop.exec("git status")
 *   laptop.readFile("/Users/me/project/src/main.ts")
 *   laptop.writeFile("/tmp/output.json", data)
 *   laptop.readdir("/Users/me/project")
 *   laptop.exists("/Users/me/.config")
 */

import * as v from 'valibot';
import { isAbortError, raceAbort } from '@kinu.run/agent-utils';
import type { VFS } from '../types/primitives';
import { makeVfsError } from '../vfs/errno';
import { shellQuote } from '../utils/shell';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { formatExecResult, parseStatLine, refusalText } from './exec-result';
import { KinuError, toKinuError } from '../obs/index';
import type { ExecutorProvider, ExecutorCapability, ExecutorStatus } from './types';
import {
  freshDeviceToolchain,
  type DeviceStatus, type DeviceToolchain,
} from './device-status';
import {
  TOOLCHAIN_PROBED_CAPABILITIES, TOOLCHAIN_UNPROBEABLE,
} from './toolchain';
import { isDeviceNotConnectedError } from './device-tunnel';
import { readExecSignal } from './signal';
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
 *
 * This was the worst of the five, because the old prose reached NO reader as a
 * failure. `No device connected.` does not begin `Error` and is not JSON, so
 * `isFailingResultText` said not-a-failure — and so did the two private prose
 * matchers that used to sit beside it, in cf-backend's Executors terminal and in
 * `read-models/workspace-diff.ts`. So `run { runtime: 'laptop' }` with
 * no device recorded outcome `ok`, the tool-failure census counted a clean call,
 * and the Executors terminal drew it as exit 0. A platform condition read as
 * success is worse than one read as a defect: nobody goes looking.
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
 * Transport the laptop executor speaks through. The actual device socket lives
 * on the user-level hub (UserDO); the agent forwards each JSON-RPC call there,
 * so one connected device serves all of a user's agents. `status()` is a cheap
 * CACHED snapshot (the executor's isAvailable()/getStatus() are sync + hot)
 * that the transport refreshes from the hub out of band; `refreshStatus()` is
 * the authoritative awaited check backends run at turn start so the turn's
 * context reflects the CURRENT device state. Tool calls do NOT gate on either —
 * they go to the hub and let it answer authoritatively, so a device that
 * connected after this runtime was built works immediately.
 */
export interface DeviceTransport {
  /** `timeoutMs: 0` means the call carries no work deadline — it ends when the
   *  device answers, the caller aborts, or the device goes away. */
  rpc(method: string, params: JsonValue[], opts?: { timeoutMs?: number }): Promise<JsonValue | undefined>;
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

function parseInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: { value: unknown },
): v.InferOutput<TSchema> | undefined {
  const result = v.safeParse(schema, input.value);
  return result.success ? result.output : undefined;
}

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
  const rpc = (method: string, params: JsonValue[], opts?: { timeoutMs?: number }): Promise<JsonValue | undefined> =>
    transport.rpc(method, params, opts);

  // Three-state lifecycle from the hub snapshot: connected, registered-but-
  // offline (the user can reconnect), or no registered device at all. The row
  // carries the machine's own NAME and whether this agent already holds its
  // grant, because "laptop" is an API namespace and no user ever called their
  // computer that.
  const getStatus = (): ExecutorStatus => {
    const s = transport.status();
    const named = s.devices?.find((d) => d.connected) ?? s.devices?.[0];
    const identity: Partial<Pick<ExecutorStatus, 'label' | 'granted'>> = {};
    if (named) identity.label = named.name;
    if (s.workspaceGranted !== undefined) identity.granted = s.workspaceGranted;
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

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Execute a command on the user\'s local machine via the device tunnel.',
      execute: async (...args: unknown[]): Promise<string> => {
        const command = parseInput(StringSchema, { value: args[0] });
        if (command === undefined) {
          return refusalText(new KinuError('bad_input', 'laptop exec: command must be a string'));
        }
        const signal = readExecSignal({ context: args[1] });
        try {
          // The device protocol has no kill RPC — abort stops the wait; the
          // command may still finish on the user's machine.
          const result = await raceAbort(
            // No transport deadline: this is arbitrary user work — a build, a
            // test suite, an install — and the transport is not the thing that
            // knows how long it should take. The bounds that DO apply stay:
            // the caller's abort signal below, the turn's own cancellation,
            // and the tunnel's liveness probe if the device disappears.
            () => rpc('exec', [command], { timeoutMs: 0 }),
            signal,
            'laptop exec aborted — the command may still finish on the device',
          );
          const parsed = v.parse(DeviceExecResultSchema, result);
          return formatExecResult(parsed);
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED_REFUSAL;
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
          return v.parse(v.string(), await rpc('readFile', [path]));
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
          const result = await rpc('writeFile', [path, content]);
          if (result !== 'ok' && !(result !== undefined && isJsonObject(result) && result.success === true)) {
            const parsedError = result !== undefined && isJsonObject(result)
              ? v.safeParse(v.string(), result.error)
              : undefined;
            const error = parsedError?.success ? parsedError.output : 'unknown error';
            // The daemon answered, and what it answered is that the write did not
            // happen — its own filesystem said no. `io`, and never `denied`: the
            // daemon reports a refused path and a full disk through the same
            // field, and `denied` is what the approval ladder means.
            return refusalText(new KinuError('io', `laptop writeFile ${path}: ${error}`));
          }
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
          const result = v.parse(DeviceListResultSchema, await rpc('listFiles', [path || '/']));
          return result.map((entry) => {
            if (isJsonObject(entry)) {
              const name = v.safeParse(v.string(), entry.name);
              if (name.success) return name.output;
            }
            return JSON.stringify(entry);
          });
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
          return v.parse(v.boolean(), await rpc('exists', [path]));
        } catch (err) {
          if (isDeviceNotConnectedError(err)) return NOT_CONNECTED_REFUSAL;
          return refusalText(deviceFailure({ doing: `laptop exists ${path}`, cause: err }));
        }
      },
    },
  };

  const files = deviceFiles(transport, consent);
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
    //   shell          `exec` runs commands through the device's own shell.
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
    // answer at all is neither — an old daemon that cannot be asked is not a
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
 * now; the error text says how the user attaches one.
 */
declare namespace laptop {
  /** Execute a command on the user's local machine */
  function exec(command: string): Promise<string>;
  /** Read a file from the user's local filesystem */
  function readFile(path: string): Promise<string>;
  /** Write a file to the user's local filesystem */
  function writeFile(path: string, content: string): Promise<string>;
  /** List directory contents on the user's local machine — or a refusal payload */
  function readdir(path: string): Promise<string[] | string>;
  /** true or false — or a refusal payload, if the device could not be asked */
  function exists(path: string): Promise<boolean | string>;
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

/**
 * Consent boundary of the device file view. The view exposes the device's REAL
 * root — a faithful window, not a lossy rewrite — but by default only the
 * consented subtree (the device connect dir, falling back to the device home)
 * is reachable. Anything outside it needs the stronger 'full_filesystem' tier.
 */
export interface DeviceFileConsent {
  /** The consented subtree, or null to fall back to the device's home. */
  consentedRoot(): string | null;
  /** Whether this agent holds the full-filesystem consent tier. */
  hasFullFilesystem(): Promise<boolean>;
}

const ALWAYS_CONSENTED: DeviceFileConsent = {
  consentedRoot: () => '/',
  hasFullFilesystem: async () => true,
};

/** The device file view, plus the one thing only the device can answer. */
export type DeviceVFS = VFS & Pick<ExecutorProvider, 'homeDir'>;

/**
 * The user's machine, in the machine's own absolute paths.
 *
 * The daemon speaks readFile/writeFile/listFiles/exists natively; stat, mkdir
 * and unlink are synthesized through `exec` (GNU stat, falling back to BSD).
 * Every call still crosses the hub's per-(agent, device) action-consent
 * chokepoint; this view adds the path-scope layer on top.
 *
 * `homeDir` is the same directory the path-scope guard measures against — the
 * consented root, or `$HOME` asked of the device once and cached. The host
 * cannot derive it: `HELLO` carries user/os/hostname and no home, and mapping
 * platform to path would be a guess.
 */
export function deviceFiles(transport: DeviceTransport, consent: DeviceFileConsent): DeviceVFS {
  const exec = async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    v.parse(DeviceExecResultSchema, await transport.rpc('exec', [command]));

  let cachedHome: string | null = null;
  const effectiveRoot = async (): Promise<string> => {
    const explicit = consent.consentedRoot();
    if (explicit) return explicit.length > 1 ? explicit.replace(/\/+$/, '') : explicit;
    if (cachedHome === null) {
      const r = await exec('printf %s "$HOME"');
      const home = r.exitCode === 0 ? r.stdout.trim() : '';
      if (!home.startsWith('/')) {
        throw makeVfsError('EACCES', 'cannot determine the consented device directory', '/');
      }
      cachedHome = home.length > 1 ? home.replace(/\/+$/, '') : home;
    }
    return cachedHome;
  };

  const guard = async (path: string, op: string): Promise<void> => {
    if (await consent.hasFullFilesystem()) return;
    const root = await effectiveRoot();
    if (path === root || root === '/' || path.startsWith(`${root}/`)) return;
    throw makeVfsError(
      'EACCES',
      `'${path}' is outside the consented device directory '${root}' — `
      + `grant this agent the full-filesystem consent tier to reach it, ${op} '${path}'`,
      path,
    );
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
    homeDir: effectiveRoot,
    async readFile(path, opts) {
      await guard(path, 'open');
      const raw = await transport.rpc('readFile', [path, { encoding: 'base64' }]);
      if (raw !== undefined && isJsonObject(raw) && raw.encoding === 'base64') {
        const content = v.safeParse(v.string(), raw.content);
        const bytes = base64ToBytes(content.success ? content.output : '');
        return opts?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      }
      const text = v.parse(v.string(), raw);
      return opts?.encoding === 'utf8' ? text : new TextEncoder().encode(text);
    },

    async writeFile(path, data) {
      await guard(path, 'open');
      let result: JsonValue | undefined;
      if (v.is(v.string(), data)) {
        result = await transport.rpc('writeFile', [path, data]);
      } else {
        const text = asLosslessText(data);
        result = text !== null
          ? await transport.rpc('writeFile', [path, text])
          : await transport.rpc('writeFile', [path, bytesToBase64(data), { encoding: 'base64' }]);
      }
      const ok = result === 'ok'
        || (result !== undefined && isJsonObject(result) && result.success === true);
      if (!ok) throw new Error(`writeFile failed on the device: ${JSON.stringify(result)}`);
    },

    async readdir(path) {
      await guard(path, 'scandir');
      const entries = v.parse(DeviceListResultSchema, await transport.rpc('listFiles', [path]));
      return entries.map((entry) => {
        if (isJsonObject(entry)) {
          const name = v.safeParse(v.string(), entry.name);
          if (name.success) return name.output;
        }
        return JSON.stringify(entry);
      });
    },

    async stat(path) {
      await guard(path, 'stat');
      const q = shellQuote(path);
      const r = await exec(`stat -c '%s %Y %F' ${q} 2>/dev/null || stat -f '%z %m %HT' ${q}`);
      if (r.exitCode !== 0) return null;
      return parseStatLine(r.stdout);
    },

    async unlink(path) {
      await guard(path, 'unlink');
      const r = await exec(`rm -- ${shellQuote(path)}`);
      if (r.exitCode !== 0) throw makeVfsError('EIO', `${r.stderr.trim() || 'operation failed'}, unlink '${path}'`, path);
    },

    async mkdir(path, opts) {
      await guard(path, 'mkdir');
      const r = await exec(`mkdir ${opts?.recursive ? '-p ' : ''}-- ${shellQuote(path)}`);
      if (r.exitCode !== 0) throw makeVfsError('EIO', `${r.stderr.trim() || 'operation failed'}, mkdir '${path}'`, path);
    },

    async exists(path) {
      await guard(path, 'stat');
      return Boolean(await transport.rpc('exists', [path]));
    },
  };
}
