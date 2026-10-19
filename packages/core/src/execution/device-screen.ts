/**
 * DeviceScreenHub pairs a viewer's socket with a screen stream on the device socket inside one DO (1014-t), as
 * DeviceTerminalHub pairs a pane with a shell. The viewer speaks RFB to the daemon; the hub relays its bytes unread, as
 * binary messages on both sockets. A stream's number rides every data frame on the device socket, so bytes a closed
 * stream left in flight reach no other viewer. Authorization happens earlier, in `deviceRpc`.
 */
import { Effect } from 'effect';
import { connections, type Connections } from '@nimbus-sh/fabric/connections.js';
import { z } from 'zod/v4';
import { diagnostics } from '../obs/log';
import { KinuError } from '../obs/error';
import type { DeviceSocket, DeviceSocketCtx, DeviceSocketHub } from './device-hub';
import { WS_OPEN } from './device-tunnel';
import { DEVICE_FRAMES, DEVICE_SCREEN_DATA } from './device-protocol';

const SCREEN_WS_TAG_PREFIX = 'screen:';

/** Covers one round trip; a stream nobody attached to is closed rather than left capturing. */
const SCREEN_ATTACH_WINDOW_MS = 30_000;

/** What a screen sends before its viewer attaches: RFB's 12-byte version, then nothing until the viewer answers. A
 *  stream past this is not speaking RFB, and ends. */
const SCREEN_HELD_BYTES = 64 * 1024;

/** WebSocket close reasons are at most 123 bytes. */
const CLOSE_REASON_BYTES = 123;

const SCREEN_SESSION_UNKNOWN = "that screen is no longer open; open the Desktop tab again";

const SCREEN_UNREAD = "the PC's screen sent more than its viewer had asked for";

/** Attachment JSON outlives the code that wrote it, so it is narrowed on read. */
const ScreenAttachmentSchema = z.object({
  screen: z.number(),
  device: z.string(),
  workspace: z.string(),
});

export interface ScreenViewer {
  stream: number;
  device: string;
  workspace: string;
}

interface PendingScreen extends ScreenViewer {
  openedAt: number;
  /** What the screen sent before its viewer attached, and why it ended if it already did: the viewer gets both. */
  held: Uint8Array[];
  heldBytes: number;
  ended: string | null;
}

function screenTag(device: string, stream: number): string {
  return `${SCREEN_WS_TAG_PREFIX}${device}:${String(stream)}`;
}

function closeReason(text: string): string {
  const bytes = new TextEncoder().encode(text);

  return bytes.byteLength <= CLOSE_REASON_BYTES ? text : new TextDecoder().decode(bytes.slice(0, CLOSE_REASON_BYTES)).replace(/\uFFFD$/u, '');
}

function randomStream(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

/** The binary messages carrying `bytes` on stream `stream`: a kind byte, the stream as a big-endian u32, then at most
 *  `DEVICE_SCREEN_DATA.maxBytes` of the stream. */
function screenDataFrames(stream: number, bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];

  for (let at = 0; at < bytes.byteLength; at += DEVICE_SCREEN_DATA.maxBytes) {
    const part = bytes.subarray(at, at + DEVICE_SCREEN_DATA.maxBytes);
    const frame = new Uint8Array(DEVICE_SCREEN_DATA.headerBytes + part.byteLength);
    const head = new DataView(frame.buffer);

    head.setUint8(0, DEVICE_SCREEN_DATA.kind);
    head.setUint32(1, stream);
    frame.set(part, DEVICE_SCREEN_DATA.headerBytes);
    frames.push(frame);
  }

  return frames;
}

/** A binary message from a device as a screen data frame; null when it is not one. Every other frame is JSON text, whose
 *  first byte is never the data kind. */
export function readScreenData(message: ArrayBuffer | ArrayBufferView): { stream: number; bytes: Uint8Array } | null {
  const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);

  if (bytes.byteLength < DEVICE_SCREEN_DATA.headerBytes || bytes[0] !== DEVICE_SCREEN_DATA.kind) return null;
  const head = new DataView(bytes.buffer, bytes.byteOffset, DEVICE_SCREEN_DATA.headerBytes);

  return { stream: head.getUint32(1), bytes: bytes.subarray(DEVICE_SCREEN_DATA.headerBytes) };
}

/** Null when the socket is a device's, a terminal pane's, or the agents SDK's. */
export function screenFromSocket(ws: DeviceSocket): ScreenViewer | null {
  const attachment = ScreenAttachmentSchema.safeParse(ws.deserializeAttachment());

  return attachment.success ? { stream: attachment.data.screen, device: attachment.data.device, workspace: attachment.data.workspace } : null;
}

export class DeviceScreenHub {
  private readonly unattached = new Map<string, PendingScreen>();

  private readonly sockets: Connections<z.infer<typeof ScreenAttachmentSchema>>;

  constructor(
    private readonly ctx: DeviceSocketCtx,
    private readonly devices: DeviceSocketHub,
    private readonly now: () => number = Date.now,
    private readonly mint: () => number = randomStream,
  ) {
    this.sockets = connections(ctx, ScreenAttachmentSchema);
  }

  /**
   * Holding the unguessable session is the authority to attach, and the first attach spends it. Registered before the
   * machine is asked to open the stream, whose RFB version arrives at once; the stream's number is minted here, unique
   * among the device's streams.
   */
  register(session: string, device: string, workspace: string): number {
    let stream = this.mint();

    while (this.viewerSocket(device, stream) !== null || this.pendingStream(device, stream) !== null) stream = this.mint();
    this.unattached.set(session, { stream, device, workspace, openedAt: this.now(), held: [], heldBytes: 0, ended: null });

    return stream;
  }

  /** A stream the machine refused to open: nothing will attach to it. */
  forget(session: string): void {
    this.unattached.delete(session);
  }

  expired(): { device: string; stream: number }[] {
    const stale: { device: string; stream: number }[] = [];

    for (const [session, pending] of this.unattached) {
      if (this.now() - pending.openedAt <= SCREEN_ATTACH_WINDOW_MS) continue;
      stale.push({ device: pending.device, stream: pending.stream });
      this.unattached.delete(session);
    }

    return stale;
  }

  /** Refuses an unknown or spent session. */
  attach(session: string, server: DeviceSocket): Effect.Effect<ScreenViewer, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const pending = this.unattached.get(session);

      if (!pending) return yield* new KinuError('missing', SCREEN_SESSION_UNKNOWN);
      this.unattached.delete(session);
      const { stream, device, workspace } = pending;

      this.sockets.accept(server, { key: screenTag(device, stream), attachment: { screen: stream, device, workspace } });

      for (const bytes of pending.held) server.send(bytes);

      if (pending.ended !== null) server.close(1000, closeReason(pending.ended));

      return { stream, device, workspace };
    });
  }

  /** The viewer's bytes, unread, to its stream. RFB from a viewer is binary; a text message is dropped and recorded. */
  fromViewer(viewer: ScreenViewer, message: string | ArrayBuffer | ArrayBufferView): void {
    const tunnel = this.devices.tunnel(viewer.device);

    if (!tunnel) {
      this.viewerSocket(viewer.device, viewer.stream)?.close(1000, closeReason(SCREEN_SESSION_UNKNOWN));

      return;
    }

    if (typeof message === 'string') {
      diagnostics.event('device.screen_text_dropped', { device: viewer.device, workspace: viewer.workspace });

      return;
    }

    const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);

    for (const frame of screenDataFrames(viewer.stream, bytes)) tunnel.sendBytes(frame);
  }

  /** The stream's bytes to its viewer; held until it attaches. A stream nobody holds is closed on the device. */
  toViewer(device: string, stream: number, bytes: Uint8Array): void {
    const viewer = this.viewerSocket(device, stream);

    if (viewer) {
      viewer.send(bytes);

      return;
    }

    const pending = this.pendingStream(device, stream);

    if (!pending) {
      diagnostics.event('device.screen_data_unclaimed', { device });
      this.closeOnDevice(device, stream);

      return;
    }

    pending.held.push(bytes.slice());
    pending.heldBytes += bytes.byteLength;

    if (pending.heldBytes <= SCREEN_HELD_BYTES) return;
    diagnostics.event('device.screen_unread', { device, workspace: pending.workspace });
    pending.held = [];
    pending.heldBytes = 0;
    pending.ended = SCREEN_UNREAD;
    this.closeOnDevice(device, stream);
  }

  /** The machine ended the stream: its viewer closes with the machine's words. */
  daemonClosed(device: string, stream: number, reason: string): void {
    const pending = this.pendingStream(device, stream);

    if (pending) pending.ended = reason;
    this.viewerSocket(device, stream)?.close(1000, closeReason(reason));
  }

  /** The machine stops capturing for a stream: its viewer's socket closed, no viewer came, or its open failed. */
  closeStream(device: string, stream: number): void {
    this.closeOnDevice(device, stream);
  }

  /** The device's socket dropped: its daemon ended every stream with it. */
  endDevice(device: string, reason: string): void {
    for (const ws of this.sockets.list()) {
      const held = this.sockets.read(ws);

      if (held?.device === device && ws.readyState === WS_OPEN) ws.close(1000, closeReason(reason));
    }

    for (const [session, pending] of this.unattached) {
      if (pending.device === device) this.unattached.delete(session);
    }
  }

  private closeOnDevice(device: string, stream: number): void {
    this.devices.tunnel(device)?.notify({ type: DEVICE_FRAMES.screenClose, stream });
  }

  private pendingStream(device: string, stream: number): PendingScreen | null {
    for (const pending of this.unattached.values()) {
      if (pending.device === device && pending.stream === stream) return pending;
    }

    return null;
  }

  private viewerSocket(device: string, stream: number): DeviceSocket | null {
    // Nimbus ask (connections socket type): get() erases the socket's send surface.
    for (const ws of this.ctx.getWebSockets(screenTag(device, stream))) {
      if (ws.readyState === WS_OPEN) return ws;
    }

    return null;
  }
}
