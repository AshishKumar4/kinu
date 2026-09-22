/**
 * DeviceTerminalHub pairs a browser socket with the device socket inside one DO; the daemon only dials out.
 * Both sockets are hibernatable, so live terminals are found from socket attachments; memory holds only
 * the open-to-attach window. Authorization happens earlier, in `deviceRpc`.
 */
import { tolerate } from '../obs/expected-failure';
import { diagnostics } from '../obs/log';
import * as v from 'valibot';
import type { DeviceSocket, DeviceSocketCtx, DeviceSocketHub } from './device-hub';
import { WS_OPEN } from './device-hub';
import {
  DEVICE_PTY_CLOSE, DEVICE_PTY_INPUT, DEVICE_PTY_MAX_AXIS, DEVICE_PTY_RESIZE,
} from './device-tunnel';

const TERMINAL_WS_TAG_PREFIX = 'terminal:';

/** Covers one round trip; an unattached session is closed rather than left running. */
const TERMINAL_ATTACH_WINDOW_MS = 30_000;

/** Each is the whole message: a device error crosses RPC as its text. */
const TERMINAL_SESSION_UNKNOWN = 'that terminal is no longer open; open a new one';

const TERMINAL_ALREADY_ATTACHED = 'that terminal is already open in another tab';

/** Attachment JSON outlives the code that wrote it, so it is narrowed on read. */
const TerminalAttachmentSchema = v.object({
  terminal: v.string(),
  device: v.string(),
  workspace: v.string(),
});

const PaneControlSchema = v.object({
  type: v.literal('resize'),
  cols: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(DEVICE_PTY_MAX_AXIS)),
  rows: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(DEVICE_PTY_MAX_AXIS)),
});

function terminalTag(session: string): string {
  return `${TERMINAL_WS_TAG_PREFIX}${session}`;
}

/** Null when the socket is a device's or the agents SDK's. */
export function terminalFromSocket(ws: DeviceSocket): { session: string; device: string; workspace: string } | null {
  const attachment = v.safeParse(TerminalAttachmentSchema, ws.deserializeAttachment());

  if (!attachment.success) return null;

  return {
    session: attachment.output.terminal,
    device: attachment.output.device,
    workspace: attachment.output.workspace,
  };
}

export interface TerminalHolder {
  device: string;
  workspace: string;
}

interface PendingSession extends TerminalHolder {
  openedAt: number;
}

export class DeviceTerminalHub {
  private readonly unattached = new Map<string, PendingSession>();

  constructor(
    private readonly ctx: DeviceSocketCtx,
    private readonly devices: DeviceSocketHub,
    private readonly now: () => number = Date.now,
  ) {}

  /** Holding the unguessable name is the authority to attach; the first attach spends it. */
  register(session: string, device: string, workspace: string): void {
    this.unattached.set(session, { device, workspace, openedAt: this.now() });
  }

  expired(): { session: string; device: string }[] {
    const stale: { session: string; device: string }[] = [];

    for (const [session, pending] of this.unattached) {
      if (this.now() - pending.openedAt <= TERMINAL_ATTACH_WINDOW_MS) continue;
      stale.push({ session, device: pending.device });
      this.unattached.delete(session);
    }

    return stale;
  }

  /** Refuses an unknown name and a second attach: two panes would race for one program's input. */
  attach(session: string, server: DeviceSocket): TerminalHolder {
    const pending = this.unattached.get(session);

    if (!pending) throw new Error(TERMINAL_SESSION_UNKNOWN);

    if (this.paneSocket(session)) throw new Error(TERMINAL_ALREADY_ATTACHED);
    this.unattached.delete(session);
    this.ctx.acceptWebSocket(server, [terminalTag(session)]);
    server.serializeAttachment({ terminal: session, device: pending.device, workspace: pending.workspace });

    return { device: pending.device, workspace: pending.workspace };
  }

  paneSocket(session: string): DeviceSocket | null {
    for (const ws of this.ctx.getWebSockets(terminalTag(session))) {
      if (ws.readyState === WS_OPEN) return ws;
    }

    return null;
  }

  /** Bytes pass through; an unrecognised control frame is dropped and recorded as a defect. */
  fromPane(session: string, device: string, message: string | ArrayBuffer | ArrayBufferView): void {
    const tunnel = this.devices.tunnel(device);

    if (!tunnel) {
      this.endPane(session, TERMINAL_SESSION_UNKNOWN);

      return;
    }

    if (message instanceof ArrayBuffer) {
      tunnel.notify({ type: DEVICE_PTY_INPUT, session, data: base64FromBytes(new Uint8Array(message)) });

      return;
    }

    if (ArrayBuffer.isView(message)) {
      const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      tunnel.notify({ type: DEVICE_PTY_INPUT, session, data: base64FromBytes(bytes) });

      return;
    }

    // Non-JSON is tolerated here and recorded below as unreadable.
    const control = v.safeParse(PaneControlSchema, tolerate(() => JSON.parse(message), 'malformed-input'));

    if (!control.success) {
      diagnostics.event('device.terminal_control_unreadable', { workspace: session });

      return;
    }

    tunnel.notify({
      type: DEVICE_PTY_RESIZE, session, cols: control.output.cols, rows: control.output.rows,
    });
  }

  toPane(session: string, bytes: Uint8Array): void {
    const pane = this.paneSocket(session);

    if (!pane) return;
    pane.send(bytes);
  }

  paneExit(session: string, exitCode: number): void {
    const pane = this.paneSocket(session);

    if (!pane) return;
    pane.send(JSON.stringify({ type: 'exit', exitCode }));
    pane.close(1000, 'the shell ended');
  }

  endPane(session: string, error: string): void {
    const pane = this.paneSocket(session);

    if (!pane) return;
    pane.send(JSON.stringify({ type: 'error', error }));
    pane.close(1000, error);
  }

  /** The pane's socket closed, so the shell is closed too. */
  paneClosed(session: string, device: string): void {
    const tunnel = this.devices.tunnel(device);

    if (!tunnel) return;
    tunnel.notify({ type: DEVICE_PTY_CLOSE, session });
  }

  panesForDevice(device: string): string[] {
    const sessions: string[] = [];

    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WS_OPEN) continue;
      const held = terminalFromSocket(ws);

      if (held && held.device === device) sessions.push(held.session);
    }

    for (const [session, pending] of this.unattached) {
      if (pending.device === device) {
        sessions.push(session);
        this.unattached.delete(session);
      }
    }

    return sessions;
  }
}

/** Chunked so a large paste cannot exceed one call's argument limit. */
function base64FromBytes(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let text = '';

  for (let at = 0; at < bytes.length; at += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }

  return btoa(text);
}
