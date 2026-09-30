/**
 * Hibernation-aware ownership of device-daemon WebSockets tagged `device:<deviceId>`; `ctx.getWebSockets()`
 * is the liveness truth and tunnels are a rebuilt cache. The toolchain probe lives on the socket attachment,
 * not SQL, so it never outlives the connection it describes.
 */
import { KinuError, toKinuError } from '../obs/error';
import { diagnostics } from '../obs/log';
import { attempt, settle } from '../obs/effect';
import { Effect } from 'effect';
import type { JsonValue } from '../utils/json';
import { DeviceTunnel, NO_DEVICE_CONNECTED, isDeviceUnknownMethodError, type TunnelSocket } from './device-tunnel';
import { DEVICE_CHATGPT, DEVICE_RELAY, DeviceRelays, parseDeviceRelayFrame, type DeviceChatGptMethod, type DeviceRelayRequest } from './device-relay';
import { REAL_CLOCK } from '../types/clock';
import { deviceToolchainAnswer, freshDeviceToolchain, type DeviceToolchain } from './device-status';
import { TOOLCHAIN_PROBE_BINARIES } from './toolchain';
import { EXECUTOR_CAPABILITIES } from './types';
import * as v from 'valibot';

/** WebSocket.OPEN; shared with the terminal hub. */
export const WS_OPEN = 1;

/** The daemon's keepalive words, verbatim (packages/pc-agent keeps its own literals). Not a hibernation
 *  auto-response: that answers every socket, including terminal panes. */
export const DEVICE_KEEPALIVE_PING = 'ping';

export const DEVICE_KEEPALIVE_PONG = 'pong';

const DEVICE_WS_TAG_PREFIX = 'device:';

/** Close reason for a replaced daemon socket; read verbatim as `SOCKET_REPLACED_REASON` in packages/pc-agent. */
const DEVICE_SOCKET_REPLACED_REASON = 'replaced by a new connection';

/** Probe round-trip deadline; short because it runs on turn assembly. A miss leaves the row unmeasured. */
const PROBE_TIMEOUT_MS = 3_000;

const WhichResultSchema = v.object({ present: v.array(v.string()) });

/** Platform WebSocket surface. `send` accepts bytes because terminal output is binary. */
export interface DeviceSocket extends TunnelSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(attachment: JsonValue): void;
  deserializeAttachment(): JsonValue | undefined;
}

/** Toolchain answer on the attachment; re-narrowed on read because attachments survive deploys. */
const DeviceToolchainSchema = v.object({
  present: v.array(v.picklist(EXECUTOR_CAPABILITIES)),
  asked: v.array(v.picklist(EXECUTOR_CAPABILITIES)),
  probedAt: v.number(),
});

/** The daemon has no `which` method; distinct from an answer of "nothing found". */
const PROBE_UNANSWERABLE = 'unanswerable';

const DeviceProbeSchema = v.union([DeviceToolchainSchema, v.literal(PROBE_UNANSWERABLE)]);

const RELAY_UNANSWERABLE = 'unanswerable';

const DeviceAttachmentSchema = v.object({
  device: v.string(),
  probe: v.optional(DeviceProbeSchema),
  relay: v.optional(v.literal(RELAY_UNANSWERABLE)),
});

type DeviceProbe = DeviceToolchain | typeof PROBE_UNANSWERABLE;

export interface DeviceSocketCtx {
  acceptWebSocket(ws: DeviceSocket, tags: string[]): void;
  getWebSockets(tag?: string): DeviceSocket[];
}

function deviceTag(deviceId: string): string {
  return `${DEVICE_WS_TAG_PREFIX}${deviceId}`;
}

/** Device id of a hibernatable socket, or null for agents-SDK sockets (attachments carry `__pk`). */
export function deviceIdFromSocket(ws: DeviceSocket): string | null {
  const attachment = v.safeParse(DeviceAttachmentSchema, ws.deserializeAttachment());

  return attachment.success ? attachment.output.device : null;
}

interface TunnelEntry {
  tunnel: DeviceTunnel;
  ws: DeviceSocket;
}

export class DeviceSocketHub {
  private readonly tunnels = new Map<string, TunnelEntry>();

  private readonly relays = new DeviceRelays();

  constructor(private readonly ctx: DeviceSocketCtx) {}

  /** Accept a daemon socket, replacing any previous one. A replacement is reported, never silent. */
  accept(deviceId: string, server: DeviceSocket): void {
    this.dropTunnel(deviceId);

    for (const old of this.ctx.getWebSockets(deviceTag(deviceId))) {
      if (old.readyState !== WS_OPEN) continue;
      diagnostics.event('device.socket_replaced', { device: deviceId });
      old.close(1000, DEVICE_SOCKET_REPLACED_REASON);
    }

    this.ctx.acceptWebSocket(server, [deviceTag(deviceId)]);
    server.serializeAttachment({ device: deviceId });
  }

  liveSocket(deviceId: string): DeviceSocket | null {
    for (const ws of this.ctx.getWebSockets(deviceTag(deviceId))) {
      if (ws.readyState === WS_OPEN) return ws;
    }

    return null;
  }

  /** The fresh toolchain answer, or null: never asked, unable to answer, or stale. Null never means "has none". */
  toolchain(deviceId: string, now: number): DeviceToolchain | null {
    const probe = this.probeRecord(deviceId);

    if (probe === null || probe === PROBE_UNANSWERABLE) return null;

    return freshDeviceToolchain(probe, now);
  }

  /**
 * Ask the machine which probe binaries it has and record the answer. Consent is not consulted: the query is
 * a fixed list of bare binary names and grants no reach beyond the capability row.
 */
  async probeToolchain(deviceId: string, now: number): Promise<DeviceToolchain | null> {
    const existing = this.probeRecord(deviceId);

    if (existing === PROBE_UNANSWERABLE) return null;
    const fresh = existing === null ? null : freshDeviceToolchain(existing, now);

    if (fresh) return fresh;

    const tunnel = this.tunnel(deviceId);

    if (!tunnel) return null;
    let present: readonly string[];

    try {
      const answered = await tunnel.rpc('which', [[...TOOLCHAIN_PROBE_BINARIES]], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      const parsed = v.safeParse(WhichResultSchema, answered);

      if (!parsed.success) throw new KinuError('io', 'device answered `which` with an unreadable payload');
      present = parsed.output.present;
    } catch (err) {
      // A method-missing error is durable for this connection; other failures are transient and re-asked next turn.
      const failure = toKinuError({ doing: 'probe the device toolchain', cause: err, otherwise: 'io' });

      if (isDeviceUnknownMethodError({ cause: err })) this.recordProbe(deviceId, PROBE_UNANSWERABLE);
      diagnostics.failure('device.toolchain_probe_failed', failure, { device: deviceId });

      return null;
    }

    const answer = deviceToolchainAnswer(present, now);
    this.recordProbe(deviceId, answer);

    return answer;
  }

  private probeRecord(deviceId: string): DeviceProbe | null {
    const ws = this.liveSocket(deviceId);

    if (!ws) return null;
    const attachment = v.safeParse(DeviceAttachmentSchema, ws.deserializeAttachment());

    return attachment.success ? attachment.output.probe ?? null : null;
  }

  private recordProbe(deviceId: string, probe: DeviceProbe): void {
    // Field by field: this wire shape outlives its writer and is read back only by `DeviceAttachmentSchema`.
    const stored: JsonValue = probe === PROBE_UNANSWERABLE
      ? probe
      : { present: [...probe.present], asked: [...probe.asked], probedAt: probe.probedAt };

    this.annotate(deviceId, { probe: stored });
  }

  private annotate(deviceId: string, patch: { probe?: JsonValue; relay?: typeof RELAY_UNANSWERABLE }): void {
    const ws = this.liveSocket(deviceId);

    if (!ws) return;
    const held = v.safeParse(DeviceAttachmentSchema, ws.deserializeAttachment());
    const { probe, relay } = held.success ? held.output : {};

    ws.serializeAttachment({
      device: deviceId,
      ...(probe !== undefined && { probe }),
      ...(relay !== undefined && { relay }),
      ...patch,
    });
  }

  relayDevice(): string | null {
    // A pane names its device too.
    for (const id of this.connectedDeviceIds()) {
      const ws = this.liveSocket(id);
      const attachment = v.safeParse(DeviceAttachmentSchema, ws?.deserializeAttachment());

      if (attachment.success && attachment.output.relay === undefined) return id;
    }

    return null;
  }

  /** Resolves at the answer's head. A daemon without the method is not picked again on this connection. */
  relay(deviceId: string, id: string, request: DeviceRelayRequest): Promise<Response> {
    const tunnel = this.tunnel(deviceId);

    if (!tunnel) return settle(Effect.fail(new KinuError('unavailable', NO_DEVICE_CONNECTED)));

    const params: JsonValue = { method: request.method, url: request.url, headers: request.headers.map(([name, value]) => [name, value]), body: request.body };

    return this.relays.open({
      id, deviceId,
      cancel: () => { if (tunnel.isConnected()) tunnel.notify({ type: DEVICE_RELAY.cancel, relay: id }); },
      answered: async () => {
        const [outcome] = await Promise.allSettled([tunnel.rpc(DEVICE_RELAY.method, [params], { requestId: id, timeoutMs: 0, extra: { deviceId } })]);

        if (outcome.status === 'rejected' && isDeviceUnknownMethodError({ cause: outcome.reason })) this.annotate(deviceId, { relay: RELAY_UNANSWERABLE });

        return outcome;
      },
    });
  }

  chatgpt(deviceId: string, method: DeviceChatGptMethod): Promise<JsonValue | null> {
    const tunnel = this.tunnel(deviceId);

    if (!tunnel) return settle(Effect.fail(new KinuError('unavailable', NO_DEVICE_CONNECTED)));
    const status = method === DEVICE_CHATGPT.status;
    const asked = attempt({ doing: 'asking the machine about its ChatGPT sign-in', otherwise: 'unavailable' }, () => tunnel.rpc(method, [], { timeoutMs: 0 }));

    return settle(asked.pipe(
      Effect.map((answer) => answer ?? null),
      Effect.catch((failure) => {
        if (isDeviceUnknownMethodError({ cause: failure })) return Effect.succeed(null);

        if (!status) return Effect.fail(failure);

        return Effect.sync(() => {
          diagnostics.failure('device.chatgpt_status_unanswered', failure, { device: deviceId });

          return null;
        });
      }),
    ));
  }

  isConnected(deviceId: string): boolean {
    return this.liveSocket(deviceId) != null;
  }

  /** Every device with a live socket, in platform order; the order is not a ranking. */
  connectedDeviceIds(): string[] {
    const ids: string[] = [];

    for (const ws of this.ctx.getWebSockets()) {
      const id = deviceIdFromSocket(ws);

      if (id && ws.readyState === WS_OPEN && !ids.includes(id)) ids.push(id);
    }

    return ids;
  }

  /** The requested device when live, else the only live one; null when several are live and none was named. */
  connectedDeviceId(deviceId?: string): string | null {
    if (deviceId) return this.isConnected(deviceId) ? deviceId : null;
    const live = this.connectedDeviceIds();

    return live.length === 1 ? live[0] : null;
  }

  /** The device's tunnel, rebuilt from the hibernatable socket after a wake. */
  tunnel(deviceId: string): DeviceTunnel | null {
    const cached = this.tunnels.get(deviceId);

    if (cached?.tunnel.isConnected()) return cached.tunnel;
    const ws = this.liveSocket(deviceId);

    if (!ws) return null;
    const tunnel = new DeviceTunnel(ws, undefined, undefined, REAL_CLOCK);
    this.tunnels.set(deviceId, { tunnel, ws });

    return tunnel;
  }

  cancelRelay(id: string): void {
    this.relays.cancel(id);
  }

  handleMessage(deviceId: string, data: string): void {
    const relayFrame = parseDeviceRelayFrame(data);

    if (relayFrame !== null) {
      this.relays.receive(deviceId, relayFrame);

      return;
    }

    this.tunnel(deviceId)?.handleMessage(data);
  }

  /** A device socket closed. Rejects in-flight calls only when it is the tunnel's own socket, not a replaced one. */
  handleClose(deviceId: string, ws: DeviceSocket): void {
    const cached = this.tunnels.get(deviceId);

    if (!cached || cached.ws !== ws) return;
    this.dropTunnel(deviceId);
  }

  private dropTunnel(deviceId: string): void {
    this.tunnels.get(deviceId)?.tunnel.dispose();
    this.tunnels.delete(deviceId);
  }

  close(deviceId: string, reason: string): void {
    this.dropTunnel(deviceId);

    for (const ws of this.ctx.getWebSockets(deviceTag(deviceId))) {
      if (ws.readyState === WS_OPEN) ws.close(1000, reason);
    }
  }
}
