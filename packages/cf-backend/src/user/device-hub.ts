/**
 * DeviceSocketHub — hibernation-aware ownership of device-daemon WebSockets.
 *
 * The UserDO accepts each daemon socket as a HIBERNATABLE WebSocket tagged
 * `device:<deviceId>` so an idle hub can sleep between calls. That makes
 * `ctx.getWebSockets()` the source of truth for liveness: the in-memory
 * DeviceTunnel map is only a cache of JSON-RPC correlators, rebuilt from the
 * surviving sockets whenever the DO instance wakes. This module owns that
 * policy (tagging, attachment marking, replace-on-reconnect, rebuild) in a
 * unit-testable home — the UserDO just wires tickets, SQL, and consent.
 */
import {
  DeviceTunnel, parseSandboxEnforcementReport,
  type TunnelSocket, type SandboxEnforcementReport,
} from '@proteus/core';

/** WebSocket.OPEN is 1 across every implementation. */
const WS_OPEN = 1;
const DEVICE_WS_TAG_PREFIX = 'device:';

/** The socket surface the hub needs — satisfied by the platform WebSocket. */
export interface DeviceSocket extends TunnelSocket {
  close(code?: number, reason?: string): void;
  serializeAttachment(attachment: unknown): void;
  deserializeAttachment(): unknown;
}

/** The DurableObjectState subset the hub needs. */
export interface DeviceSocketCtx {
  acceptWebSocket(ws: DeviceSocket, tags: string[]): void;
  getWebSockets(tag?: string): DeviceSocket[];
}

export function deviceTag(deviceId: string): string {
  return `${DEVICE_WS_TAG_PREFIX}${deviceId}`;
}

/** The deviceId a hibernatable socket was accepted for, or null for sockets
 *  owned by the agents SDK (their attachments carry `__pk`, not `device`). */
export function deviceIdFromSocket(ws: DeviceSocket): string | null {
  try {
    const attachment = ws.deserializeAttachment() as { device?: unknown } | null;
    return attachment && typeof attachment.device === 'string' ? attachment.device : null;
  } catch {
    return null;
  }
}

/** The sandbox report a daemon announced in HELLO, persisted in the socket
 *  attachment so it survives DO hibernation alongside the device tag. */
function sandboxFromSocket(ws: DeviceSocket): SandboxEnforcementReport | null {
  try {
    const attachment = ws.deserializeAttachment() as { sandbox?: unknown } | null;
    return parseSandboxEnforcementReport(attachment?.sandbox);
  } catch {
    return null;
  }
}

interface TunnelEntry {
  tunnel: DeviceTunnel;
  ws: DeviceSocket;
}

export class DeviceSocketHub {
  private readonly tunnels = new Map<string, TunnelEntry>();

  constructor(private readonly ctx: DeviceSocketCtx) {}

  /** Accept a daemon socket for a device, replacing any previous connection. */
  accept(deviceId: string, server: DeviceSocket): void {
    this.dropTunnel(deviceId);
    for (const old of this.ctx.getWebSockets(deviceTag(deviceId))) {
      try { old.close(1000, 'replaced by a new connection'); } catch { /* nop */ }
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

  isConnected(deviceId: string): boolean {
    return this.liveSocket(deviceId) != null;
  }

  /** The id of a connected device — the requested one, or the first live one. */
  connectedDeviceId(deviceId?: string): string | null {
    if (deviceId) return this.isConnected(deviceId) ? deviceId : null;
    for (const ws of this.ctx.getWebSockets()) {
      const id = deviceIdFromSocket(ws);
      if (id && ws.readyState === WS_OPEN) return id;
    }
    return null;
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

  /** Feed an incoming device frame: HELLO frames carry the daemon's sandbox
   *  policy (stashed on the socket attachment); everything else goes to the
   *  device's tunnel as an RPC response. */
  handleMessage(deviceId: string, data: string): void {
    try {
      const msg = JSON.parse(data) as { type?: unknown; sandbox?: unknown };
      if (msg?.type === 'HELLO') {
        const sandbox = parseSandboxEnforcementReport(msg.sandbox);
        const ws = this.liveSocket(deviceId);
        if (sandbox && ws) ws.serializeAttachment({ device: deviceId, sandbox });
        return;
      }
    } catch { /* not JSON — let the tunnel's own parser ignore it */ }
    this.tunnel(deviceId)?.handleMessage(data);
  }

  /** The sandbox policy + enforcement the connected daemon reported, or null
   *  (pre-sandbox daemons / no live socket). Consent and status surfaces use
   *  this to show the mode being approved. */
  sandboxReport(deviceId: string): SandboxEnforcementReport | null {
    const ws = this.liveSocket(deviceId);
    return ws ? sandboxFromSocket(ws) : null;
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
      try { ws.close(1000, reason); } catch { /* nop */ }
    }
  }
}
