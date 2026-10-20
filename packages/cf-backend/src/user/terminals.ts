import { Effect } from 'effect';
import {
  DEVICE_PTY_MAX_AXIS, nanoid, type UserCaller, DeviceTerminalHub, DEVICE_FRAMES, DEVICE_METHOD, NO_DEVICE_CONNECTED, type DeviceSocket,
} from '@kinu.run/core';
import { attempt, attemptInItsWords, authoredRefusal, diagnostics, KinuError, renderThrownChain, settle, tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { SessionRecord, TerminalSession } from '@kinu.run/devbox';
import type { UserDevices } from './devices';
import type { UserObjectHost } from './user-host';

/** Read before the RPC correlator: these frames carry no request id, and the correlator
 *  would drop them silently. */
const DeviceTerminalFrameSchema = v.variant('type', [
  v.object({ type: v.literal(DEVICE_FRAMES.ptyOutput), session: v.string(), data: v.string() }),
  v.object({ type: v.literal(DEVICE_FRAMES.ptyExit), session: v.string(), exitCode: v.number() }),
]);

const TERMINAL_DEFAULT_AXIS = { cols: 80, rows: 24 } as const;

const TERMINAL_RECONNECTED = 'the PC reconnected; open the terminal again';

const TERMINAL_ALREADY_OPEN = 'that terminal is already open in another tab';

/** A session as the daemon keeps it (packages/pc-agent/src/daemon/terminals.js): its id, name and folder. */
const DeviceSessionRecordSchema = v.object({ id: v.string(), name: v.string(), cwd: v.nullable(v.string()) });

/** A session as the daemon lists it: whether a shell runs in it now, and what that shell runs. */
const DeviceSessionSchema = v.object({
  id: v.string(), name: v.string(), cwd: v.string(), open: v.boolean(), running: v.nullable(v.string()),
});

/** Control round-trip timeout, not the terminal's life; also the default for every other
 *  control call on this socket. */
const TERMINAL_OPEN_TIMEOUT_MS = 10_000;

function bytesFromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);

  return bytes;
}

export interface UserTerminalsHost extends Pick<UserObjectHost, 'ctx' | 'requireTier'> {
  readonly devices: UserDevices;
}

/** Pane terminals on the owner's machines. */
export class UserTerminals {
  /** Pane sockets paired with device sessions; both live here because the device socket does. */
  readonly _terminals: DeviceTerminalHub;

  constructor(private readonly host: UserTerminalsHost) {
    this._terminals = new DeviceTerminalHub(host.ctx, host.devices._devices);
  }

  /**
   * The session name is the authority: minted once after ownership and consent checks, spent by first
   * attach. An upgrade carries no `UserCaller`, so the check happens in {@link openDeviceTerminal}.
   */
  acceptTerminalSocket(request: Request, url: URL): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const token = url.searchParams.get('session') ?? '';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    let attached: { device: string; workspace: string };

    try {
      attached = this._terminals.attach(token, server);
    } catch (cause) {
      // Unknown or taken session is expected (shell ended or object evicted); the pane opens a new one.
      return new Response(renderThrownChain({ cause: authoredRefusal({ doing: 'attaching a terminal pane', cause }) }), { status: 409 });
    }

    diagnostics.event('device.terminal_attached', { device: attached.device, workspace: attached.workspace });
    const init: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };

    return new Response(null, init);
  }

  /** Returns true if the frame was a terminal frame (so skip the RPC correlator); exit closes the pane. A device's frame
   *  reaches only its own sessions' panes. */
  handleTerminalFrame(deviceId: string, data: string): boolean {
    const frame = v.safeParse(DeviceTerminalFrameSchema, tolerate(() => JSON.parse(data), 'malformed-input'));

    if (!frame.success) return false;

    if ('data' in frame.output) {
      this._terminals.toPane(deviceId, frame.output.session, bytesFromBase64(frame.output.data));

      return true;
    }

    this._terminals.paneExit(deviceId, frame.output.session, frame.output.exitCode);

    return true;
  }

  /**
   * Open the workspace's named session `session` on the owner's machine (its first when none is named), resuming a shell
   * that runs detached; returns the token its pane attaches with. Goes through `deviceRpc` (tier, per-device grant,
   * Sandbox switch); there is no other way to open one.
   */
  async openDeviceTerminal(
    caller: UserCaller,
    agentName: string,
    window: { cols: number; rows: number },
    target: { device?: string; session?: string },
  ): Promise<{ session: string }> {
    // Gate first: a refused caller must not learn whether a machine is connected.
    await this.host.requireTier(caller, 'device.rpc');

    return settle(Effect.gen({ self: this }, function* () {
      const bounded = (axis: number, fallback: number): number => (
        Number.isInteger(axis) && axis >= 1 && axis <= DEVICE_PTY_MAX_AXIS ? axis : fallback
      );

      const token = `pty-${nanoid(16)}`;
      // Resolved before minting: several live devices and none named is an error.
      const device = yield* this.host.devices.resolveDeviceForCall(target.device, undefined);
      // The first session's id is the daemon's; a pane that names none learns it from the open's answer.
      const named = target.session ?? (yield* this.firstSession(caller, agentName, device));

      // Tokens no pane spent are swept first, their sessions detached unless another pane holds them: this object's one
      // alarm belongs to other work.
      for (const stale of this._terminals.expired()) yield* this.closeDeviceTerminal(stale);

      // Refused before the machine is asked: an open replays the session's output to, and resizes, whoever holds it.
      if (this._terminals.claimed(device, named)) return yield* Effect.fail(new KinuError('denied', TERMINAL_ALREADY_OPEN));

      // Known before the machine is asked, so what its shell draws first, or a resumed one kept, waits for the pane.
      this._terminals.register(token, { session: named, device, workspace: agentName });
      yield* attemptInItsWords('io', () => this.host.devices.deviceRpc(
        caller,
        DEVICE_METHOD.ptyOpen,
        [bounded(window.cols, TERMINAL_DEFAULT_AXIS.cols), bounded(window.rows, TERMINAL_DEFAULT_AXIS.rows), named],
        { agentName, deviceId: device, requestId: token, timeoutMs: TERMINAL_OPEN_TIMEOUT_MS },
      )).pipe(Effect.tapError(() => Effect.sync(() => this._terminals.forget(token))));

      return { session: token };
    }));
  }

  /** A device socket served its HELLO: panes open on the device were attached through an earlier socket, whose daemon
   *  detached their sessions with it. Each closes, and opens again on this one. */
  deviceConnected(deviceId: string): void {
    this._terminals.endDevice(deviceId, TERMINAL_RECONNECTED);
  }

  /** A device socket closed. A replacement already live owns the device's panes now, and a late close from the socket it
   *  replaced leaves them be. */
  deviceClosed(deviceId: string): void {
    if (this.host.devices._devices.liveSocket(deviceId) === null) this._terminals.endDevice(deviceId, NO_DEVICE_CONNECTED);
  }

  /** The pane `closing` closed, or a token went unspent: the session keeps running on the machine, detached (1014-t). */
  closeDeviceTerminal(holder: { device: string; session: string }, closing?: DeviceSocket): Effect.Effect<void> {
    const { device, session } = holder;

    return attempt({ doing: 'detach the device terminal', otherwise: 'unavailable' }, async () => { this._terminals.paneClosed(device, session, closing); }).pipe(
      Effect.catch((failure) => Effect.sync(() => diagnostics.failure('device.terminal_close_unsent', failure, { device }))),
    );
  }

  /** The workspace's sessions on `deviceId`, as the strip reads the computer's (D90). */
  async listDeviceSessions(caller: UserCaller, agentName: string, deviceId: string): Promise<TerminalSession[]> {
    const listed = await this.sessionCall({ caller, agentName, deviceId, method: DEVICE_METHOD.ptyList, params: [] }, v.array(DeviceSessionSchema));

    return listed.map((session) => ({ ...session, last: null, ports: [], branch: null, needsInput: false }));
  }

  async openDeviceSession(caller: UserCaller, agentName: string, deviceId: string, name?: string): Promise<SessionRecord> {
    const params = name === undefined ? [] : [name];

    return asRecord(await this.sessionCall({ caller, agentName, deviceId, method: DEVICE_METHOD.ptyCreate, params }, DeviceSessionRecordSchema));
  }

  async renameDeviceSession(caller: UserCaller, agentName: string, deviceId: string, request: { id: string; name: string }): Promise<SessionRecord> {
    const params = [request.id, request.name];

    return asRecord(await this.sessionCall({ caller, agentName, deviceId, method: DEVICE_METHOD.ptyRename, params }, DeviceSessionRecordSchema));
  }

  async closeDeviceSession(caller: UserCaller, agentName: string, deviceId: string, id: string): Promise<void> {
    await this.sessionCall({ caller, agentName, deviceId, method: DEVICE_METHOD.ptyClose, params: [id] }, v.null());
  }

  private firstSession(caller: UserCaller, agentName: string, deviceId: string): Effect.Effect<string, KinuError> {
    return attemptInItsWords('io', () => this.listDeviceSessions(caller, agentName, deviceId)).pipe(Effect.flatMap(([first]) => (
      first === undefined ? Effect.fail(new KinuError('missing', 'this machine lists no terminal session for the workspace')) : Effect.succeed(first.id)
    )));
  }

  /** A session call is a device call for this workspace: gated as a terminal's open is, its answer the daemon's JSON as
   *  `schema` reads it. */
  private async sessionCall<T>(
    call: { caller: UserCaller; agentName: string; deviceId: string; method: string; params: string[] },
    schema: v.GenericSchema<unknown, T>,
  ): Promise<T> {
    const { caller, agentName, deviceId, method, params } = call;
    const answer = await this.host.devices.deviceRpc(caller, method, params, { agentName, deviceId, timeoutMs: TERMINAL_OPEN_TIMEOUT_MS });

    return v.parse(schema, answer === undefined ? null : JSON.parse(answer));
  }
}

/** A daemon's record as the strip's: a session that never opened has no folder yet. */
function asRecord(record: v.InferOutput<typeof DeviceSessionRecordSchema>): SessionRecord {
  return { id: record.id, name: record.name, cwd: record.cwd ?? '' };
}
