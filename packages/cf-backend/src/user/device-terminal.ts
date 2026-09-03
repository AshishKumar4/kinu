/**
 * DeviceTerminalHub — the pairing that lets a browser drive a terminal on the
 * owner's own machine.
 *
 * Two sockets, one Durable Object. The device's socket already terminates here
 * (`DeviceSocketHub`), and it is the only way into that machine: the daemon
 * dials out and nothing dials in. A browser socket accepted HERE therefore
 * needs no second transport and no inbound port — bytes cross from one socket
 * to the other inside this object, which is why the browser's socket is
 * accepted by the same DO rather than by the route that authorised it.
 *
 * Both sockets are hibernatable and their attachments survive eviction, so a
 * live terminal is found again from the sockets themselves rather than from a
 * map this instance happens to hold. The one thing memory owns is the window
 * between opening a session and the browser attaching to it, which is two
 * calls in one request.
 *
 * What this module deliberately does NOT do: decide whether a terminal may
 * exist. That is settled before a session is ever registered here, by the same
 * `deviceRpc` gate every device call passes — the workspace's capability tier,
 * the per-(workspace, device) grant, and the owner's Sandbox switch. This
 * module moves bytes between two sockets that were already allowed to talk.
 */
import {
  DEVICE_PTY_CLOSE, DEVICE_PTY_INPUT, DEVICE_PTY_MAX_AXIS, DEVICE_PTY_RESIZE,
} from '@kinu.run/core';
import { diagnostics, tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { DeviceSocket, DeviceSocketCtx, DeviceSocketHub } from './device-hub';

/** WebSocket.OPEN is 1 across every implementation. */
const WS_OPEN = 1;
const TERMINAL_WS_TAG_PREFIX = 'terminal:';

/**
 * How long a session stays attachable after it opens.
 *
 * The browser attaches on the next hop of the same request, so this covers a
 * round trip and nothing more. A session nobody attached to is a shell running
 * on the owner's machine with no window on it, and it is closed rather than
 * left.
 */
export const TERMINAL_ATTACH_WINDOW_MS = 30_000;

/** Why the pane could not attach, in words a person can act on. Each is the
 *  whole message: a device error crosses an RPC boundary as its text. */
export const TERMINAL_SESSION_UNKNOWN = 'that terminal is no longer open; open a new one';
export const TERMINAL_ALREADY_ATTACHED = 'that terminal is already open in another tab';

/** What a browser socket carries so a woken object knows what it is holding.
 *  An attachment is JSON we wrote, and it outlives the code that wrote it, so
 *  it is narrowed on the way back in. */
const TerminalAttachmentSchema = v.object({
  terminal: v.string(),
  device: v.string(),
  workspace: v.string(),
});

/** The control frames a pane sends. Bytes go as binary; only a new window is
 *  worth a word, and its numbers are bounded here as the kernel bounds them. */
const PaneControlSchema = v.object({
  type: v.literal('resize'),
  cols: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(DEVICE_PTY_MAX_AXIS)),
  rows: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(DEVICE_PTY_MAX_AXIS)),
});

export function terminalTag(session: string): string {
  return `${TERMINAL_WS_TAG_PREFIX}${session}`;
}

/** The session a hibernatable socket was accepted for, or null when the socket
 *  is a device's or the agents SDK's. */
export function terminalFromSocket(ws: DeviceSocket): { session: string; device: string; workspace: string } | null {
  const attachment = v.safeParse(TerminalAttachmentSchema, ws.deserializeAttachment());
  if (!attachment.success) return null;
  return {
    session: attachment.output.terminal,
    device: attachment.output.device,
    workspace: attachment.output.workspace,
  };
}

/** The machine and the workspace a terminal belongs to. */
export interface TerminalHolder {
  device: string;
  workspace: string;
}

interface PendingSession extends TerminalHolder {
  openedAt: number;
}

export class DeviceTerminalHub {
  /** Sessions opened on a device and not yet attached to a pane. */
  private readonly unattached = new Map<string, PendingSession>();

  constructor(
    private readonly ctx: DeviceSocketCtx,
    private readonly devices: DeviceSocketHub,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record a session the device just opened, so the pane that asked for it can
   * attach on the next hop.
   *
   * Holding the name IS the authority to attach, the way holding a connect
   * ticket is the authority to be that device: the name is unguessable, it was
   * handed to one authenticated caller, and it is spent by the first attach.
   */
  register(session: string, device: string, workspace: string): void {
    this.unattached.set(session, { device, workspace, openedAt: this.now() });
  }

  /** Sessions that opened and were never attached, so their shells can be shut
   *  down rather than left running behind a window nobody opened. */
  expired(): { session: string; device: string }[] {
    const stale: { session: string; device: string }[] = [];
    for (const [session, pending] of this.unattached) {
      if (this.now() - pending.openedAt <= TERMINAL_ATTACH_WINDOW_MS) continue;
      stale.push({ session, device: pending.device });
      this.unattached.delete(session);
    }
    return stale;
  }

  /**
   * Accept a pane's socket for a session this object opened.
   *
   * Refuses an unknown name and refuses a second attach: one terminal has one
   * foreground program, so two panes on one session would race for its input.
   */
  attach(session: string, server: DeviceSocket): TerminalHolder {
    const pending = this.unattached.get(session);
    if (!pending) throw new Error(TERMINAL_SESSION_UNKNOWN);
    if (this.paneSocket(session)) throw new Error(TERMINAL_ALREADY_ATTACHED);
    this.unattached.delete(session);
    this.ctx.acceptWebSocket(server, [terminalTag(session)]);
    server.serializeAttachment({ terminal: session, device: pending.device, workspace: pending.workspace });
    return { device: pending.device, workspace: pending.workspace };
  }

  /** The open pane socket for a session, if any. */
  paneSocket(session: string): DeviceSocket | null {
    for (const ws of this.ctx.getWebSockets(terminalTag(session))) {
      if (ws.readyState === WS_OPEN) return ws;
    }
    return null;
  }

  /**
   * A pane's message, on its way to the machine.
   *
   * Bytes go as they came, which is what makes an arrow key an arrow key. A
   * control frame this hub does not recognise is dropped and recorded: the
   * pane and this object ship together, so an unreadable one is a defect to
   * find rather than a case to accommodate.
   */
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
    // A frame that is not JSON at all is the one failure this boundary
    // tolerates by name: the socket carries what the browser wrote. It is
    // recorded below as unreadable, with everything else that is not a resize.
    const control = v.safeParse(PaneControlSchema, tolerate(() => JSON.parse(message), 'malformed-input'));
    if (!control.success) {
      diagnostics.event('device.terminal_control_unreadable', { workspace: session });
      return;
    }
    tunnel.notify({
      type: DEVICE_PTY_RESIZE, session, cols: control.output.cols, rows: control.output.rows,
    });
  }

  /** Terminal output, on its way to the pane that is watching it. */
  toPane(session: string, bytes: Uint8Array): void {
    const pane = this.paneSocket(session);
    if (!pane) return;
    pane.send(bytes);
  }

  /** The shell ended. The pane is told the status and the socket closes: a
   *  terminal whose program is gone has nothing left to carry. */
  paneExit(session: string, exitCode: number): void {
    const pane = this.paneSocket(session);
    if (!pane) return;
    pane.send(JSON.stringify({ type: 'exit', exitCode }));
    pane.close(1000, 'the shell ended');
  }

  /** Tell the pane why it has no terminal, then close. */
  endPane(session: string, error: string): void {
    const pane = this.paneSocket(session);
    if (!pane) return;
    pane.send(JSON.stringify({ type: 'error', error }));
    pane.close(1000, error);
  }

  /**
   * The pane's socket closed, so the shell is closed too.
   *
   * A terminal is something a person is watching. One whose window is gone has
   * nobody to draw for, and leaving it running would leave a shell on the
   * owner's machine that nothing can reach.
   */
  paneClosed(session: string, device: string): void {
    const tunnel = this.devices.tunnel(device);
    if (!tunnel) return;
    tunnel.notify({ type: DEVICE_PTY_CLOSE, session });
  }

  /** Every live pane socket, for a device whose own socket just dropped. */
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

/** Bytes as base64, because the device socket carries JSON. Chunked so a large
 *  paste cannot exceed the argument limit of one call. */
function base64FromBytes(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let text = '';
  for (let at = 0; at < bytes.length; at += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(text);
}
