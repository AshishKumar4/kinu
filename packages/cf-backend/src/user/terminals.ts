import { Effect } from 'effect';
import {
  DEVICE_PTY_OPEN_METHOD, DEVICE_PTY_OUTPUT, DEVICE_PTY_EXIT, DEVICE_PTY_MAX_AXIS, nanoid, type UserCaller, DeviceTerminalHub,
} from '@kinu.run/core';
import { attempt, attemptInItsWords, authoredRefusal, diagnostics, renderThrownChain, settle, tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { UserDevices } from './devices';
import type { UserObjectHost } from './user-host';

/** Read before the RPC correlator: these frames carry no request id, and the correlator
 *  would drop them silently. */
const DeviceTerminalFrameSchema = v.variant('type', [
  v.object({ type: v.literal(DEVICE_PTY_OUTPUT), session: v.string(), data: v.string() }),
  v.object({ type: v.literal(DEVICE_PTY_EXIT), session: v.string(), exitCode: v.number() }),
]);

const TERMINAL_DEFAULT_AXIS = { cols: 80, rows: 24 } as const;

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

    const session = url.searchParams.get('session') ?? '';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    let attached: { device: string; workspace: string };

    try {
      attached = this._terminals.attach(session, server);
    } catch (cause) {
      // Unknown or taken session is expected (shell ended or object evicted); the pane opens a new one.
      return new Response(renderThrownChain({ cause: authoredRefusal({ doing: 'attaching a terminal pane', cause }) }), { status: 409 });
    }

    server.send(JSON.stringify({ type: 'ready' }));
    diagnostics.event('device.terminal_attached', { device: attached.device, workspace: attached.workspace });
    const init: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };

    return new Response(null, init);
  }

  /** Returns true if the frame was a terminal frame (so skip the RPC correlator); exit closes the pane. */
  handleTerminalFrame(data: string): boolean {
    const frame = v.safeParse(DeviceTerminalFrameSchema, tolerate(() => JSON.parse(data), 'malformed-input'));

    if (!frame.success) return false;

    if ('data' in frame.output) {
      this._terminals.toPane(frame.output.session, bytesFromBase64(frame.output.data));

      return true;
    }

    this._terminals.paneExit(frame.output.session, frame.output.exitCode);

    return true;
  }

  /**
   * Open a terminal on the owner's machine for one workspace; returns the session its pane attaches to.
   * Goes through `deviceRpc` (tier, per-device grant, Sandbox switch); there is no other way to open one.
   */
  async openDeviceTerminal(
    caller: UserCaller,
    agentName: string,
    window: { cols: number; rows: number },
    deviceId?: string,
  ): Promise<{ session: string }> {
    // Gate first: a refused caller must not learn whether a machine is connected.
    await this.host.requireTier(caller, 'device.rpc');

    return settle(Effect.gen({ self: this }, function* () {
      const bounded = (axis: number, fallback: number): number => (
        Number.isInteger(axis) && axis >= 1 && axis <= DEVICE_PTY_MAX_AXIS ? axis : fallback
      );

      const session = `pty-${nanoid(16)}`;
      // Resolved before minting: several live devices and none named is an error.
      const target = yield* this.host.devices.resolveDeviceForCall(deviceId, undefined);

      yield* attemptInItsWords('io', () => this.host.devices.deviceRpc(
        caller,
        DEVICE_PTY_OPEN_METHOD,
        [bounded(window.cols, TERMINAL_DEFAULT_AXIS.cols), bounded(window.rows, TERMINAL_DEFAULT_AXIS.rows)],
        { agentName, deviceId: target, requestId: session, timeoutMs: TERMINAL_OPEN_TIMEOUT_MS },
      ));

      this._terminals.register(session, target, agentName);

      // Unattached sessions are swept on the next open: this object's one alarm belongs to other work.
      for (const stale of this._terminals.expired()) yield* this.closeDeviceTerminal(stale.session, stale.device);

      return { session };
    }));
  }

  closeDeviceTerminal(session: string, device: string): Effect.Effect<void> {
    return attempt({ doing: 'close the device terminal', otherwise: 'unavailable' }, () => this._terminals.paneClosed(session, device)).pipe(
      Effect.catch((failure) => Effect.sync(() => diagnostics.failure('device.terminal_close_unsent', failure, { device }))),
    );
  }
}
