/**
 * DeviceSocketHub — hibernation-aware ownership of device-daemon WebSockets,
 * and the toolchain answer that belongs to each one.
 *
 * The UserDO accepts each daemon socket as a HIBERNATABLE WebSocket tagged
 * `device:<deviceId>` so an idle hub can sleep between calls. That makes
 * `ctx.getWebSockets()` the source of truth for liveness: the in-memory
 * DeviceTunnel map is only a cache of JSON-RPC correlators, rebuilt from the
 * surviving sockets whenever the DO instance wakes. This module owns that
 * policy (tagging, attachment marking, replace-on-reconnect, rebuild) in a
 * unit-testable home — the UserDO just wires tickets, SQL, and consent.
 *
 * It owns the toolchain probe for the same reason it owns liveness: the answer
 * describes ONE machine over ONE connection, and the socket attachment is the
 * only store with exactly that lifetime. Kept out of SQL deliberately — a
 * `user_devices` column would outlive the machine it described, so a different
 * laptop reconnecting under the same device row would inherit its predecessor's
 * capabilities, and a stale answer would read as a fresh one.
 */
import {
  DeviceTunnel, EXECUTOR_CAPABILITIES, TOOLCHAIN_PROBE_BINARIES, isDeviceUnknownMethodError,
  deviceToolchainAnswer, freshDeviceToolchain,
  type DeviceToolchain, type JsonValue, type TunnelSocket,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';

/** WebSocket.OPEN is 1 across every implementation. */
const WS_OPEN = 1;
const DEVICE_WS_TAG_PREFIX = 'device:';

/**
 * Deadline for the probe round-trip. Short on purpose: it runs on the path that
 * assembles a turn's device status, so a machine that is connected but too busy
 * to answer must cost that turn a moment, not its patience. Missing the deadline
 * leaves the row unmeasured and the next turn asks again.
 */
const PROBE_TIMEOUT_MS = 3_000;

const WhichResultSchema = v.object({ present: v.array(v.string()) });

/** The socket surface the hub needs — satisfied by the platform WebSocket.
 *
 *  `send` widens core's text-only `TunnelSocket`, because one of these sockets
 *  carries a terminal's output and that is BYTES: decoding a screen repaint as
 *  text would corrupt every escape sequence in it. The device protocol itself
 *  stays JSON, so the tunnel keeps the narrower view. */
export interface DeviceSocket extends TunnelSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(attachment: JsonValue): void;
  deserializeAttachment(): JsonValue | undefined;
}

/**
 * The toolchain answer as it rides the socket attachment. Narrowed to declared
 * capability ids on the way back in: an attachment is JSON we wrote, but it
 * survives a code deploy, so what a previous version wrote is untrusted input.
 */
const DeviceToolchainSchema = v.object({
  present: v.array(v.picklist(EXECUTOR_CAPABILITIES)),
  asked: v.array(v.picklist(EXECUTOR_CAPABILITIES)),
  probedAt: v.number(),
});

/** The daemon was asked and has no `which` method — an install too old to
 *  answer. Recorded so the hub stops asking a socket that cannot reply, and
 *  kept distinct from an answer of "nothing found": this machine may well have
 *  python, and nobody knows. */
const PROBE_UNANSWERABLE = 'unanswerable';

const DeviceProbeSchema = v.union([DeviceToolchainSchema, v.literal(PROBE_UNANSWERABLE)]);

/** What one connection has told us. `probe` absent means never asked. */
const DeviceAttachmentSchema = v.object({
  device: v.string(),
  probe: v.optional(DeviceProbeSchema),
});

/** What one connection has told us, in the domain's own type — the schema above
 *  only narrows what comes back OUT of an attachment. */
type DeviceProbe = DeviceToolchain | typeof PROBE_UNANSWERABLE;

/** The DurableObjectState subset the hub needs. */
export interface DeviceSocketCtx {
  acceptWebSocket(ws: DeviceSocket, tags: string[]): void;
  getWebSockets(tag?: string): DeviceSocket[];
}

function deviceTag(deviceId: string): string {
  return `${DEVICE_WS_TAG_PREFIX}${deviceId}`;
}

/** The deviceId a hibernatable socket was accepted for, or null for sockets
 *  owned by the agents SDK (their attachments carry `__pk`, not `device`). */
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

  /**
   * Accept a daemon socket for a device, replacing any previous connection.
   *
   * A replacement is REPORTED, never silent: one device id with two live
   * claimants is either a redialling daemon or somebody holding a copy of that
   * machine's `device.json`, and the second case is invisible unless this says
   * so. The UserDO stamps `replaced_at` on the row for the same reason — a
   * diagnostic the owner never opens is not a notification.
   */
  accept(deviceId: string, server: DeviceSocket): void {
    this.dropTunnel(deviceId);
    for (const old of this.ctx.getWebSockets(deviceTag(deviceId))) {
      if (old.readyState !== WS_OPEN) continue;
      diagnostics.event('device.socket_replaced', { device: deviceId });
      old.close(1000, 'replaced by a new connection');
    }
    this.ctx.acceptWebSocket(server, [deviceTag(deviceId)]);
    server.serializeAttachment({ device: deviceId });
  }

  /** The open hibernatable socket for a device, if any. */
  liveSocket(deviceId: string): DeviceSocket | null {
    for (const ws of this.ctx.getWebSockets(deviceTag(deviceId))) {
      if (ws.readyState === WS_OPEN) return ws;
    }
    return null;
  }

  /**
   * The attached machine's toolchain answer, when there is a fresh one.
   *
   * Null covers three different situations and says so to nobody: never asked,
   * asked and unable to answer, and answered too long ago to still be evidence.
   * They are the same to a reader — "this machine has not told us" — and none of
   * them is "this machine has no python", which is exactly the claim a two-state
   * capability row would have made.
   */
  toolchain(deviceId: string, now: number): DeviceToolchain | null {
    const probe = this.probeRecord(deviceId);
    if (probe === null || probe === PROBE_UNANSWERABLE) return null;
    return freshDeviceToolchain(probe, now);
  }

  /**
   * Ask the machine which of the probe's binaries it has, and record the answer
   * against its current socket. Answers whatever is now known, so a caller can
   * use the result directly.
   *
   * Consent is deliberately not consulted, and this is the one call on the
   * device plane where that is the right answer. `deviceRpc` gates every call
   * that carries an agent name because the agent is acting on the owner's
   * machine; this is the hub's own bookkeeping, like `checkpointStatus`, and the
   * question is closed by construction — the daemon is handed a fixed list of
   * bare binary names from core's table and answers which of THOSE exist. There
   * is no path from it to enumerating the machine, reading a file, or running a
   * command, so it grants no reach that the capability row does not need.
   */
  async probeToolchain(deviceId: string, now: number): Promise<DeviceToolchain | null> {
    const existing = this.probeRecord(deviceId);
    // An install with no `which` will not grow one while this socket is open.
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
      // A daemon too old to know the method says so in its error frame, and that
      // is a durable property of this connection — record it and stop asking.
      // Every other failure (a timeout, a dropped socket, a payload we could not
      // read) is transient: leave the record untouched so the next turn re-asks.
      const failure = toKinuError({ doing: 'probe the device toolchain', cause: err, otherwise: 'io' });
      if (isDeviceUnknownMethodError(err)) this.recordProbe(deviceId, PROBE_UNANSWERABLE);
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
    // Written out field by field rather than spread: this is a wire shape that
    // outlives the code that wrote it, and `DeviceAttachmentSchema` above is the
    // only thing that will ever read it back.
    const stored: JsonValue = probe === PROBE_UNANSWERABLE
      ? probe
      : { present: [...probe.present], asked: [...probe.asked], probedAt: probe.probedAt };
    ws.serializeAttachment({ device: deviceId, probe: stored });
  }

  isConnected(deviceId: string): boolean {
    return this.liveSocket(deviceId) != null;
  }

  /** Every device with a live socket right now, in socket order. The order is
   *  the platform's, not a ranking: nothing here may read it as one. */
  connectedDeviceIds(): string[] {
    const ids: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const id = deviceIdFromSocket(ws);
      if (id && ws.readyState === WS_OPEN && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * The id of THE connected device: the requested one when it is live, or —
   * with no request — the only live one. Null when several are live and none
   * was named.
   *
   * This used to answer the unnamed case with the FIRST live socket in
   * `ctx.getWebSockets()` iteration order. With two machines connected that
   * order is the platform's, and a redial or a wake can change it between two
   * calls in one turn, so the "connected device" — its name, its toolchain,
   * its sandbox, the machine a command ran on — took turns being either one.
   * A fleet of several has no "the"; a caller that needs one names it.
   */
  connectedDeviceId(deviceId?: string): string | null {
    if (deviceId) return this.isConnected(deviceId) ? deviceId : null;
    const live = this.connectedDeviceIds();
    return live.length === 1 ? live[0]! : null;
  }

  /** The DeviceTunnel for a connected device — rebuilt from the hibernatable
   *  socket when this DO instance woke after the socket was accepted. */
  tunnel(deviceId: string): DeviceTunnel | null {
    const cached = this.tunnels.get(deviceId);
    if (cached?.tunnel.isConnected()) return cached.tunnel;
    const ws = this.liveSocket(deviceId);
    if (!ws) return null;
    const tunnel = new DeviceTunnel(ws);
    this.tunnels.set(deviceId, { tunnel, ws });
    return tunnel;
  }

  /** Feed an incoming RPC-response frame to the device's tunnel. */
  handleMessage(deviceId: string, data: string): void {
    this.tunnel(deviceId)?.handleMessage(data);
  }

  /** A device socket closed. Rejects its tunnel's in-flight calls — but only
   *  when the closing socket is the tunnel's own (a replaced socket's close
   *  event arrives AFTER its replacement was accepted and must not tear down
   *  the new tunnel). */
  handleClose(deviceId: string, ws: DeviceSocket): void {
    const cached = this.tunnels.get(deviceId);
    if (!cached || cached.ws !== ws) return;
    this.dropTunnel(deviceId);
  }

  /** Forget the device's tunnel; in-flight calls reject. */
  private dropTunnel(deviceId: string): void {
    this.tunnels.get(deviceId)?.tunnel.dispose();
    this.tunnels.delete(deviceId);
  }

  /** Close every socket for a device (revocation). */
  close(deviceId: string, reason: string): void {
    this.dropTunnel(deviceId);
    for (const ws of this.ctx.getWebSockets(deviceTag(deviceId))) {
      if (ws.readyState === WS_OPEN) ws.close(1000, reason);
    }
  }
}
