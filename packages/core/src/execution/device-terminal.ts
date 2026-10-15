/**
 * DeviceTerminalHub pairs a browser socket with the device socket inside one DO; the daemon only dials out.
 * Both sockets are hibernatable, so live terminals are found from socket attachments; memory holds only
 * the open-to-attach window. Authorization happens earlier, in `deviceRpc`.
 */
import { Effect } from 'effect';
import { tolerate, settleSync } from '../obs/effect';
import { diagnostics } from '../obs/log';
import { KinuError } from '../obs/error';
import { bytesToBase64 } from '../utils/base64';
import * as v from 'valibot';
import { connections, type Connections } from '@nimbus-sh/fabric/connections.js';
import { z } from 'zod/v4';
import type { DeviceSocket, DeviceSocketCtx, DeviceSocketHub } from './device-hub';
import { WS_OPEN } from './device-tunnel';
import { DEVICE_PTY_MAX_AXIS, DEVICE_FRAMES } from './device-protocol';

const TERMINAL_WS_TAG_PREFIX = 'terminal:';

/** Covers one round trip; an unattached session is closed rather than left running. */
const TERMINAL_ATTACH_WINDOW_MS = 30_000;

/** What a shell may draw before its pane attaches: its prompt, or why it ended, many times over. Past it the oldest go,
 *  as a congested daemon drops them: a terminal's newest bytes are its picture. */
const TERMINAL_HELD_BYTES = 64 * 1024;

/** Each is the whole message: a device error crosses RPC as its text. */
const TERMINAL_SESSION_UNKNOWN = 'that terminal is no longer open; open a new one';

const TERMINAL_ALREADY_ATTACHED = 'that terminal is already open in another tab';

/** Attachment JSON outlives the code that wrote it, so it is narrowed on read. */
const TerminalAttachmentSchema = z.object({
  terminal: z.string(),
  device: z.string(),
  workspace: z.string(),
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
  const attachment = TerminalAttachmentSchema.safeParse(ws.deserializeAttachment());

  if (!attachment.success) return null;

  return {
    session: attachment.data.terminal,
    device: attachment.data.device,
    workspace: attachment.data.workspace,
  };
}

export interface TerminalHolder {
  device: string;
  workspace: string;
}

interface PendingSession extends TerminalHolder {
  openedAt: number;
  /** What the shell drew before its pane attached, and its end if it already ended: the pane gets both first. */
  held: Uint8Array[];
  heldBytes: number;
  exitCode: number | null;
}

export class DeviceTerminalHub {
  private readonly unattached = new Map<string, PendingSession>();

  private readonly sockets: Connections<z.infer<typeof TerminalAttachmentSchema>>;

  constructor(
    private readonly ctx: DeviceSocketCtx,
    private readonly devices: DeviceSocketHub,
    private readonly now: () => number = Date.now,
  ) {
    this.sockets = connections(ctx, TerminalAttachmentSchema);
  }

  /**
   * Holding the unguessable name is the authority to attach; the first attach spends it. Registered before the machine
   * is asked to open it: the shell draws its prompt at once, and on f9c17ac7b those bytes, and an exit, reached this
   * hub before the session was known and were dropped, so the pane sat blank or closed without a word.
   */
  register(session: string, device: string, workspace: string): void {
    this.unattached.set(session, { device, workspace, openedAt: this.now(), held: [], heldBytes: 0, exitCode: null });
  }

  /** A session the machine refused to open: nothing will attach to it. */
  forget(session: string): void {
    this.unattached.delete(session);
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
    return settleSync(Effect.gen({ self: this }, function* () {
      const pending = this.unattached.get(session);

      if (!pending) return yield* new KinuError('missing', TERMINAL_SESSION_UNKNOWN);

      if (this.paneSocket(session)) return yield* new KinuError('denied', TERMINAL_ALREADY_ATTACHED);
      this.unattached.delete(session);
      this.sockets.accept(server, {
        key: terminalTag(session), attachment: { terminal: session, device: pending.device, workspace: pending.workspace },
      });
      server.send(JSON.stringify({ type: 'ready' }));

      for (const bytes of pending.held) server.send(bytes);

      if (pending.exitCode !== null) this.paneExit(session, pending.exitCode);

      return { device: pending.device, workspace: pending.workspace };
    }));
  }

  paneSocket(session: string): DeviceSocket | null {
    // Nimbus ask (connections socket type): get() erases the socket's send surface.
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
      tunnel.notify({ type: DEVICE_FRAMES.ptyInput, session, data: bytesToBase64(new Uint8Array(message)) });

      return;
    }

    if (ArrayBuffer.isView(message)) {
      const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      tunnel.notify({ type: DEVICE_FRAMES.ptyInput, session, data: bytesToBase64(bytes) });

      return;
    }

    // Non-JSON is tolerated here and recorded below as unreadable.
    const control = v.safeParse(PaneControlSchema, tolerate(() => JSON.parse(message), 'malformed-input'));

    if (!control.success) {
      diagnostics.event('device.terminal_control_unreadable', { workspace: session });

      return;
    }

    tunnel.notify({
      type: DEVICE_FRAMES.ptyResize, session, cols: control.output.cols, rows: control.output.rows,
    });
  }

  toPane(session: string, bytes: Uint8Array): void {
    const pane = this.paneSocket(session);
    const pending = pane ? undefined : this.unattached.get(session);

    if (pending) {
      pending.held.push(bytes);
      pending.heldBytes += bytes.byteLength;

      while (pending.heldBytes > TERMINAL_HELD_BYTES && pending.held.length > 1) pending.heldBytes -= pending.held.shift()?.byteLength ?? 0;

      return;
    }

    if (!pane) {
      diagnostics.event('device.terminal_output_unclaimed', { reason: 'terminal_pane_missing', workspace: session });

      return;
    }

    pane.send(bytes);
  }

  paneExit(session: string, exitCode: number): void {
    const pane = this.paneSocket(session);
    const pending = pane ? undefined : this.unattached.get(session);

    if (pending) pending.exitCode = exitCode;

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
  async paneClosed(session: string, device: string): Promise<void> {
    const tunnel = this.devices.tunnel(device);

    if (!tunnel) return;
    await tunnel.cancel(session);
  }

  panesForDevice(device: string): string[] {
    const sessions: string[] = [];

    for (const ws of this.sockets.list()) {
      const held = this.sockets.read(ws);

      if (held && held.device === device) sessions.push(held.terminal);
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
