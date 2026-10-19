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

/** Covers one round trip; a token no pane spends in it is dropped, and its session keeps running, detached. */
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

function terminalTag(device: string, session: string): string {
  return `${TERMINAL_WS_TAG_PREFIX}${device}:${session}`;
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
  /** The workspace's named session on the device (1014-t): the daemon's name for it, stable across panes. */
  session: string;
  device: string;
  workspace: string;
}

interface PendingAttach extends TerminalHolder {
  openedAt: number;
  /** What the shell drew before its pane attached, and its end if it already ended: the pane gets both first. */
  held: Uint8Array[];
  heldBytes: number;
  exitCode: number | null;
}

export class DeviceTerminalHub {
  /** By attach token: the unguessable, single-use authority a pane's upgrade carries. */
  private readonly unattached = new Map<string, PendingAttach>();

  private readonly sockets: Connections<z.infer<typeof TerminalAttachmentSchema>>;

  constructor(
    private readonly ctx: DeviceSocketCtx,
    private readonly devices: DeviceSocketHub,
    private readonly now: () => number = Date.now,
  ) {
    this.sockets = connections(ctx, TerminalAttachmentSchema);
  }

  /**
   * Holding the unguessable token is the authority to attach to `holder.session`; the first attach spends it.
   * Registered before the machine is asked to open the session: the shell draws its prompt at once, or a resumed one
   * its kept output, and on f9c17ac7b those bytes, and an exit, reached this hub before the session was known and were
   * dropped, so the pane sat blank or closed without a word.
   */
  register(token: string, holder: TerminalHolder): void {
    this.unattached.set(token, { ...holder, openedAt: this.now(), held: [], heldBytes: 0, exitCode: null });
  }

  /** An open the machine refused: nothing will attach with this token. */
  forget(token: string): void {
    this.unattached.delete(token);
  }

  /** Tokens no pane spent in time, each with the session the machine keeps running for the next pane. */
  expired(): TerminalHolder[] {
    const stale: TerminalHolder[] = [];

    for (const [token, pending] of this.unattached) {
      if (this.now() - pending.openedAt <= TERMINAL_ATTACH_WINDOW_MS) continue;
      stale.push({ session: pending.session, device: pending.device, workspace: pending.workspace });
      this.unattached.delete(token);
    }

    return stale;
  }

  /** Refuses an unknown token and a second pane on one session: two panes would race for one program's input. */
  attach(token: string, server: DeviceSocket): TerminalHolder {
    return settleSync(Effect.gen({ self: this }, function* () {
      const pending = this.unattached.get(token);

      if (!pending) return yield* new KinuError('missing', TERMINAL_SESSION_UNKNOWN);

      if (this.paneSocket(pending.device, pending.session)) return yield* new KinuError('denied', TERMINAL_ALREADY_ATTACHED);
      this.unattached.delete(token);
      const { session, device, workspace } = pending;

      this.sockets.accept(server, { key: terminalTag(device, session), attachment: { terminal: session, device, workspace } });
      server.send(JSON.stringify({ type: 'ready' }));

      for (const bytes of pending.held) server.send(bytes);

      if (pending.exitCode !== null) this.paneExit(device, session, pending.exitCode);

      return { session, device, workspace };
    }));
  }

  paneSocket(device: string, session: string): DeviceSocket | null {
    // Nimbus ask (connections socket type): get() erases the socket's send surface.
    for (const ws of this.ctx.getWebSockets(terminalTag(device, session))) {
      if (ws.readyState === WS_OPEN) return ws;
    }

    return null;
  }

  /** Bytes pass through; an unrecognised control frame is dropped and recorded as a defect. */
  fromPane(holder: TerminalHolder, message: string | ArrayBuffer | ArrayBufferView): void {
    const { session, device } = holder;
    const tunnel = this.devices.tunnel(device);

    if (!tunnel) {
      this.endPane(device, session, TERMINAL_SESSION_UNKNOWN);

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
      diagnostics.event('device.terminal_control_unreadable', { workspace: holder.workspace });

      return;
    }

    tunnel.notify({
      type: DEVICE_FRAMES.ptyResize, session, cols: control.output.cols, rows: control.output.rows,
    });
  }

  /** The device's bytes for its own session: a pane of another device's session with the same name never gets them. */
  toPane(device: string, session: string, bytes: Uint8Array): void {
    const pane = this.paneSocket(device, session);

    if (pane) {
      pane.send(bytes);

      return;
    }

    const pending = this.pendingFor(device, session);

    if (pending.length === 0) {
      diagnostics.event('device.terminal_output_unclaimed', { reason: 'terminal_pane_missing', device });

      return;
    }

    for (const held of pending) {
      held.held.push(bytes);
      held.heldBytes += bytes.byteLength;

      while (held.heldBytes > TERMINAL_HELD_BYTES && held.held.length > 1) held.heldBytes -= held.held.shift()?.byteLength ?? 0;
    }
  }

  paneExit(device: string, session: string, exitCode: number): void {
    const pane = this.paneSocket(device, session);

    for (const pending of this.pendingFor(device, session)) pending.exitCode = exitCode;

    if (!pane) return;
    pane.send(JSON.stringify({ type: 'exit', exitCode }));
    pane.close(1000, 'the shell ended');
  }

  endPane(device: string, session: string, error: string): void {
    const pane = this.paneSocket(device, session);

    if (!pane) return;
    pane.send(JSON.stringify({ type: 'error', error }));
    pane.close(1000, error);
  }

  /** The pane's socket closed: the session keeps running on the machine, detached, for the next pane (1014-t). */
  paneClosed(device: string, session: string): void {
    this.devices.tunnel(device)?.notify({ type: DEVICE_FRAMES.ptyDetach, session });
  }

  /** The device's socket dropped: its panes end with why, and tokens not yet spent with them. */
  endDevice(device: string, error: string): void {
    for (const ws of this.sockets.list()) {
      const held = this.sockets.read(ws);

      if (held && held.device === device) this.endPane(device, held.terminal, error);
    }

    for (const [token, pending] of this.unattached) {
      if (pending.device === device) this.unattached.delete(token);
    }
  }

  private pendingFor(device: string, session: string): PendingAttach[] {
    return [...this.unattached.values()].filter((pending) => pending.device === device && pending.session === session);
  }
}
