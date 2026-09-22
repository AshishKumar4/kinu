/**
 * Hibernation-aware ownership of device-daemon WebSockets tagged `device:<deviceId>`; `ctx.getWebSockets()`
 * is the liveness truth and tunnels are a rebuilt cache. The toolchain probe lives on the socket attachment,
 * not SQL, so it never outlives the connection it describes.
 */
import { KinuError, toKinuError } from '../obs/error';
import { diagnostics } from '../obs/log';
import type { JsonValue } from '../utils/json';
import { DeviceTunnel, isDeviceUnknownMethodError, type TunnelSocket } from './device-tunnel';
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

const DeviceAttachmentSchema = v.object({
  device: v.string(),
  probe: v.optional(DeviceProbeSchema),
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
    const ws = this.liveSocket(deviceId);

    if (!ws) return;

    // Field by field: this wire shape outlives its writer and is read back only by `DeviceAttachmentSchema`.
    const stored: JsonValue = probe === PROBE_UNANSWERABLE
      ? probe
      : { present: [...probe.present], asked: [...probe.asked], probedAt: probe.probedAt };

    ws.serializeAttachment({ device: deviceId, probe: stored });
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

  handleMessage(deviceId: string, data: string): void {
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
