import { Effect } from 'effect';
import { nanoid, type UserCaller, DeviceScreenHub, DEVICE_FRAMES, DEVICE_METHOD, NO_DEVICE_CONNECTED } from '@kinu.run/core';
import { attemptInItsWords, authoredRefusal, diagnostics, renderThrownChain, settle, settleSync, tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { UserDevices } from './devices';
import type { UserObjectHost } from './user-host';

/** Read before the RPC correlator: it carries no request id. */
const ScreenCloseFrameSchema = v.object({
  type: v.literal(DEVICE_FRAMES.screenClose),
  stream: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0xffffffff)),
  reason: v.optional(v.string(), 'the PC closed its screen'),
});

/** Control round-trip timeout, not the screen's life: the daemon answers once its capture runs. */
const SCREEN_OPEN_TIMEOUT_MS = 15_000;

const SCREEN_RECONNECTED = 'the PC reconnected; open the Desktop tab again';

/** RFB over WebSocket names this subprotocol; a browser that asked for it refuses an upgrade that does not echo it. */
const RFB_SUBPROTOCOL = 'binary';

export interface UserScreensHost extends Pick<UserObjectHost, 'ctx' | 'requireTier'> {
  readonly devices: UserDevices;
}

/** Desktop viewers on the owner's machines (1014-t). */
export class UserScreens {
  /** Viewer sockets paired with device streams; both live here because the device socket does. */
  readonly _screens: DeviceScreenHub;

  constructor(private readonly host: UserScreensHost) {
    this._screens = new DeviceScreenHub(host.ctx, host.devices._devices);
  }

  /** The session is the authority, minted once after ownership and consent checks in {@link openDeviceScreen} and spent
   *  by the first attach: an upgrade carries no `UserCaller`. */
  acceptScreenSocket(request: Request, url: URL): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const session = url.searchParams.get('session') ?? '';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const asked = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((protocol) => protocol.trim());

    return settleSync(this._screens.attach(session, server).pipe(Effect.match({
      // Unknown or spent session is expected (the stream ended or the object was evicted); the tab opens a new one.
      onFailure: (cause) => new Response(renderThrownChain({ cause: authoredRefusal({ doing: 'attaching a desktop viewer', cause }) }), { status: 409 }),
      onSuccess: (attached) => {
        diagnostics.event('device.screen_attached', { device: attached.device, workspace: attached.workspace });

        const init: ResponseInit & { webSocket: WebSocket } = {
          status: 101,
          webSocket: client,
          headers: asked.includes(RFB_SUBPROTOCOL) ? { 'Sec-WebSocket-Protocol': RFB_SUBPROTOCOL } : {},
        };

        return new Response(null, init);
      },
    })));
  }

  /** A device socket served its HELLO: every screen open on the device was opened on an earlier socket, whose daemon
   *  ended its streams with it. */
  deviceConnected(deviceId: string): void {
    this._screens.endDevice(deviceId, SCREEN_RECONNECTED);
  }

  /** A device socket closed. A replacement already live owns the device's screens now, and a late close from the socket
   *  it replaced leaves them be. */
  deviceClosed(deviceId: string): void {
    if (this.host.devices._devices.liveSocket(deviceId) === null) this._screens.endDevice(deviceId, NO_DEVICE_CONNECTED);
  }

  /** True when the frame was the machine closing a stream (so skip the RPC correlator). */
  handleScreenFrame(deviceId: string, data: string): boolean {
    const frame = v.safeParse(ScreenCloseFrameSchema, tolerate(() => JSON.parse(data), 'malformed-input'));

    if (!frame.success) return false;
    this._screens.daemonClosed(deviceId, frame.output.stream, frame.output.reason);

    return true;
  }

  /**
   * Open the screen of the owner's machine for one workspace; returns the session its viewer attaches to. Goes through
   * `deviceRpc` (tier, the workspace's grant on the device, its consent epoch); there is no other way to open one.
   */
  async openDeviceScreen(caller: UserCaller, agentName: string, deviceId?: string): Promise<{ session: string }> {
    // Gate first: a refused caller must not learn whether a machine is connected.
    await this.host.requireTier(caller, 'device.rpc');

    return settle(Effect.gen({ self: this }, function* () {
      const session = `scr-${nanoid(16)}`;
      const target = yield* this.host.devices.resolveDeviceForCall(deviceId, undefined);
      // Known before the machine is asked, so the RFB version it sends first waits for the viewer.
      const stream = this._screens.register(session, target, agentName);

      yield* attemptInItsWords('io', () => this.host.devices.deviceRpc(
        caller,
        DEVICE_METHOD.screenOpen,
        [stream],
        { agentName, deviceId: target, requestId: session, timeoutMs: SCREEN_OPEN_TIMEOUT_MS },
      )).pipe(Effect.tapError(() => Effect.sync(() => {
        // A timed-out open may still have started its capture.
        this._screens.forget(session);
        this._screens.closeStream(target, stream);
      })));

      // Unattached streams are closed on the next open: this object's one alarm belongs to other work.
      for (const stale of this._screens.expired()) this._screens.closeStream(stale.device, stale.stream);

      return { session };
    }));
  }
}
