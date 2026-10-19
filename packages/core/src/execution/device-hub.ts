/**
 * Hibernation-aware ownership of device-daemon WebSockets tagged `device:<deviceId>`; `ctx.getWebSockets()`
 * is the liveness truth and tunnels are a rebuilt cache. The toolchain probe lives on the socket attachment,
 * not SQL, so it never outlives the connection it describes.
 */
import { KinuError } from '../obs/error';
import { diagnostics } from '../obs/log';
import { attempt, settle } from '../obs/effect';
import { Effect } from 'effect';
import type { JsonValue } from '../utils/json';
import { DeviceTunnel, NO_DEVICE_CONNECTED, type TunnelSocket } from './device-tunnel';
import { DEVICE_ERRORS, DEVICE_METHOD, DEVICE_FEATURES, DEVICE_PROTOCOL_VERSION, DEVICE_VERSION_REFUSAL_CLOSE, DEVICE_UPDATE_REQUIRED, deviceFailure } from './device-protocol';
import { DeviceRelays, parseDeviceRelayFrame, type DeviceRelayRequest } from './device-relay';
import { REAL_CLOCK } from '../types/clock';
import { deviceToolchainAnswer, freshDeviceToolchain, type DeviceToolchain } from './device-status';
import { TOOLCHAIN_PROBE_BINARIES } from './toolchain';
import { EXECUTOR_CAPABILITIES } from './types';
import { connections, type Connections, type ConnectionSocket, type ConnectionsContext } from '@nimbus-sh/fabric/connections.js';
import { z } from 'zod/v4';
import * as v from 'valibot';


const DEVICE_WS_TAG_PREFIX = 'device:';

/** Probe round-trip deadline; short because it runs on turn assembly. A miss leaves the row unmeasured. */
const PROBE_TIMEOUT_MS = 3_000;

const WhichResultSchema = v.object({ present: v.array(v.string()) });

/** Platform WebSocket surface. `send` accepts bytes because terminal output is binary. */
export interface DeviceSocket extends TunnelSocket, ConnectionSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
}

/** Structured-cloned numbers have the same domain as the protocol's valibot number. */
const AttachmentNumberSchema = z.union([z.number(), z.literal(Infinity), z.literal(-Infinity)]);

/** Toolchain answer on the attachment; re-narrowed on read because attachments survive deploys. */
const DeviceToolchainSchema = z.object({
  present: z.array(z.enum(EXECUTOR_CAPABILITIES)),
  asked: z.array(z.enum(EXECUTOR_CAPABILITIES)),
  probedAt: AttachmentNumberSchema,
});

const DeviceAttachmentSchema = z.object({
  device: z.string(),
  protocolVersion: AttachmentNumberSchema.optional(),
  features: z.array(z.string()).optional(),
  probe: DeviceToolchainSchema.optional(),
  relays: z.array(z.string()).optional(),
});

export interface DeviceSocketCtx extends ConnectionsContext<DeviceSocket> {
  acceptWebSocket(ws: DeviceSocket, tags: string[]): void;
}

function deviceTag(deviceId: string): string {
  return `${DEVICE_WS_TAG_PREFIX}${deviceId}`;
}

/** Device id of a hibernatable socket, or null for agents-SDK sockets (attachments carry `__pk`). */
export function deviceIdFromSocket(ws: DeviceSocket): string | null {
  const attachment = DeviceAttachmentSchema.safeParse(ws.deserializeAttachment());

  return attachment.success ? attachment.data.device : null;
}

interface TunnelEntry {
  tunnel: DeviceTunnel;
  ws: DeviceSocket;
  recovery: Promise<void> | null;
}

export class DeviceSocketHub {
  private readonly tunnels = new Map<string, TunnelEntry>();

  private readonly relays = new DeviceRelays();

  private readonly sockets: Connections<z.infer<typeof DeviceAttachmentSchema>, DeviceSocket>;

  constructor(ctx: DeviceSocketCtx) {
    this.sockets = connections(ctx, DeviceAttachmentSchema);
  }

  /** Accept a daemon socket, replacing any previous one. A replacement is reported, never silent. */
  accept(deviceId: string, server: DeviceSocket): void {
    this.dropTunnel(deviceId);

    for (const _socket of this.sockets.list(deviceTag(deviceId))) {
      diagnostics.event('device.socket_replaced', { device: deviceId });
    }

    this.sockets.accept(server, { key: deviceTag(deviceId), attachment: { device: deviceId } });
  }

  /**
   * What a daemon's HELLO admits it to. `serve`: the current protocol, every method announced; its socket carries
   * calls. `update`: the protocol before this one, held open only so the hub can push it the build that brings it
   * here, with no tunnel, so no call reaches it. Anything else is refused and its socket closed.
   */
  hello(deviceId: string, version: number, features: readonly string[]): 'serve' | 'update' | 'refused' {
    if (version === DEVICE_PROTOCOL_VERSION && DEVICE_FEATURES.every((method) => features.includes(method))) {
      this.annotate(deviceId, { protocolVersion: version, features: [...features] });

      return 'serve';
    }

    // Whatever this socket was admitted to before, it serves nothing now: no tunnel, and none rebuilt after a wake.
    this.dropTunnel(deviceId);
    this.withdraw(deviceId);

    if (version === DEVICE_PROTOCOL_VERSION - 1) return 'update';
    this.refuse(deviceId);

    return 'refused';
  }

  /** Closes the device's socket as one whose daemon must update first. */
  refuse(deviceId: string): void {
    diagnostics.event('device.protocol_refused', { device: deviceId, reason: DEVICE_UPDATE_REQUIRED });
    this.liveSocket(deviceId)?.close(DEVICE_VERSION_REFUSAL_CLOSE, DEVICE_UPDATE_REQUIRED);
  }

  liveSocket(deviceId: string): DeviceSocket | null {
    return this.sockets.get(deviceTag(deviceId));
  }

  /** The fresh toolchain answer, or null: never asked, unable to answer, or stale. Null never means "has none". */
  toolchain(deviceId: string, now: number): DeviceToolchain | null {
    const probe = this.probeRecord(deviceId);

    if (probe === null) return null;

    return freshDeviceToolchain(probe, now);
  }

  /**
 * Ask the machine which probe binaries it has and record the answer. Consent is not consulted: the query is
 * a fixed list of bare binary names and grants no reach beyond the capability row.
 */
  probeToolchain(deviceId: string, now: number): Promise<DeviceToolchain | null> {
    const existing = this.probeRecord(deviceId);
    const fresh = existing === null ? null : freshDeviceToolchain(existing, now);

    if (fresh) return Promise.resolve(fresh);
    const tunnel = this.tunnel(deviceId);

    if (!tunnel) return Promise.resolve(null);

    return settle(attempt({ doing: 'probe the device toolchain', otherwise: 'io' }, () => tunnel.rpc(
      DEVICE_METHOD.which, [[...TOOLCHAIN_PROBE_BINARIES]], { timeoutMs: PROBE_TIMEOUT_MS },
    )).pipe(
      Effect.flatMap((answered) => {
        const parsed = v.safeParse(WhichResultSchema, answered);

        return parsed.success ? Effect.succeed(deviceToolchainAnswer(parsed.output.present, now))
          : Effect.fail(new KinuError('io', 'device answered which with an unreadable payload'));
      }),
      Effect.tap((answer) => Effect.sync(() => this.recordProbe(deviceId, answer))),
      Effect.catch((failure) => Effect.sync(() => {
        diagnostics.failure('device.toolchain_probe_failed', failure, { device: deviceId });

        return null;
      })),
    ));
  }

  private probeRecord(deviceId: string): DeviceToolchain | null {
    const ws = this.liveSocket(deviceId);

    if (!ws) return null;

    return this.sockets.read(ws)?.probe ?? null;
  }

  private recordProbe(deviceId: string, probe: DeviceToolchain): void {
    this.annotate(deviceId, { probe: { present: [...probe.present], asked: [...probe.asked], probedAt: probe.probedAt } });
  }

  /** The socket's attachment without its serving admission (protocol and methods), so no tunnel is built from it. */
  private withdraw(deviceId: string): void {
    const ws = this.liveSocket(deviceId);
    const attachment = ws === null ? null : this.sockets.read(ws);

    if (ws === null || attachment === null) return;
    const { protocolVersion: _protocol, features: _features, ...kept } = attachment;

    this.sockets.write(ws, kept);
  }

  private annotate(deviceId: string, patch: Partial<Omit<z.infer<typeof DeviceAttachmentSchema>, 'device'>>): void {
    const ws = this.liveSocket(deviceId);

    if (!ws) return;
    this.sockets.write(ws, { ...this.sockets.read(ws) ?? { device: deviceId }, ...patch });
  }

  relayDevice(): string | null {
    // A pane names its device too.
    for (const id of this.connectedDeviceIds()) {
      const ws = this.liveSocket(id);
      const attachment = ws === null ? null : this.sockets.read(ws);

      if (attachment?.features?.includes(DEVICE_METHOD.codexRelay)) return id;
    }

    return null;
  }

  /** Resolves at the answer's head; active ids survive on the socket to stop orphaned relays after eviction. */
  async relay(deviceId: string, id: string, request: DeviceRelayRequest): Promise<Response> {
    const tunnel = this.tunnel(deviceId);

    if (!tunnel) return settle(Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, NO_DEVICE_CONNECTED)));
    const recovery = this.tunnels.get(deviceId)?.recovery;

    if (recovery) await recovery;

    const params: JsonValue = { method: request.method, url: request.url, headers: request.headers.map(([name, value]) => [name, value]), body: request.body };

    const ws = this.liveSocket(deviceId);
    const attachment = ws === null ? null : this.sockets.read(ws);
    this.annotate(deviceId, { relays: [...attachment?.relays ?? [], id] });

    return this.relays.open({
      id, deviceId,
      cancel: () => tunnel.cancel(id),
      answered: async () => {
        const [outcome] = await Promise.allSettled([tunnel.rpc(DEVICE_METHOD.codexRelay, [params], { requestId: id, timeoutMs: 0, extra: { deviceId } })]);

        const live = this.liveSocket(deviceId);
        const remaining = live === null ? null : this.sockets.read(live);
        this.annotate(deviceId, { relays: (remaining?.relays ?? []).filter((active) => active !== id) });

        return outcome;
      },
    });
  }

  /** `method` one of the protocol's ChatGPT sign-in calls (`DEVICE_METHOD.chatgptStatus`, `chatgptSignIn`, `chatgptSignOut`). */
  chatgpt(deviceId: string, method: string, params: JsonValue[] = []): Promise<JsonValue | null> {
    const tunnel = this.tunnel(deviceId);

    if (!tunnel) return settle(Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, NO_DEVICE_CONNECTED)));
    const status = method === DEVICE_METHOD.chatgptStatus;
    const asked = attempt({ doing: 'asking the machine about its ChatGPT sign-in', otherwise: 'unavailable' }, () => tunnel.rpc(method, params, { timeoutMs: 0 }));

    return settle(asked.pipe(
      Effect.map((answer) => answer ?? null),
      Effect.catch((failure) => {
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

    for (const ws of this.sockets.list()) {
      const id = this.sockets.read(ws)?.device;

      if (id && !ids.includes(id)) ids.push(id);
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
    const attachment = this.sockets.read(ws);

    // Only a socket admitted to serve this protocol carries calls.
    if (attachment?.protocolVersion !== DEVICE_PROTOCOL_VERSION) return null;
    const tunnel = new DeviceTunnel(ws, undefined, undefined, REAL_CLOCK);
    const interrupted = attachment.relays ?? [];

    const recovery = interrupted.length === 0 ? null : Promise.all(interrupted.map(async (id) => {
      diagnostics.event('device.relay_interrupted', { device: deviceId, reason: 'hub_restarted' });
      await tunnel.cancel(id);
    })).then(() => undefined);

    this.tunnels.set(deviceId, { tunnel, ws, recovery });

    if (attachment.relays?.length) this.annotate(deviceId, { relays: [] });

    return tunnel;
  }

  cancelRelay(id: string): Promise<void> {
    return this.relays.cancel(id);
  }

  handleMessage(deviceId: string, data: string): void {
    const tunnel = this.tunnel(deviceId);

    if (!tunnel) {
      diagnostics.event('device.pre_hello_frame_dropped', { device: deviceId, reason: 'before_hello' });

      return;
    }

    const relayFrame = parseDeviceRelayFrame(data);

    if (relayFrame !== null) {
      this.relays.receive(deviceId, relayFrame);

      return;
    }

    tunnel.handleMessage(data);
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

    for (const ws of this.sockets.list(deviceTag(deviceId))) ws.close(1000, reason);
  }
}
