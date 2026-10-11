// A preview's WebSocket keeps its workspace's dev server alive while it stays open, quiet or not (Kinu's Nimbus patch,
// NIMBUS-ASKS #43). 0.17 counts a client only by its traffic in the last 60 s, so a browser holding a quiet HMR socket
// lost the dev server behind it. Asserted against the installed, patched Nimbus: core's port registry relays the
// upgrade so its close is seen, and worker's keep-alive holds the resident while it is open.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import * as v from 'valibot';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { RESIDENT_KEEPALIVE_MS } from '@nimbus-sh/platform/limits.js';

// The keep-alive rule is not on worker's export map; the test reads the installed module itself.
const HibernationSchema = v.object({
  holdResidentClient: v.function(),
  residentKeepaliveFired: v.function(),
  noteResidentClient: v.function(),
});

const hibernation = v.parse(HibernationSchema, await import(join(import.meta.dir, '../../../node_modules/@nimbus-sh/worker/dist/session/hibernation.js')));

interface KeepaliveHost {
  processes: { residentRunning: number };
  _w1KeepaliveArmed: boolean;
  _w1LastClientActivityAt: number;
  _w1OpenClientSockets: number;
  _w1SessionDestroyed: boolean;
}

/** What an end's listener hears: a frame's data, or a close's code and reason. */
interface SocketEvent {
  readonly data?: string;
  readonly code?: number;
  readonly reason?: string;
}

/** workerd's WebSocket end: events delivered once accepted, a close carried to the peer with its code and reason. */
class PairedSocket {
  readyState: number = WebSocket.OPEN;

  peer: PairedSocket | null = null;

  private accepted = false;

  private readonly listeners = new Map<string, ((event: SocketEvent) => void)[]>();

  private readonly pending: [string, SocketEvent][] = [];

  accept(): void {
    this.accepted = true;

    for (const [type, event] of this.pending.splice(0)) this.dispatch(type, event);
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }

  send(data: string): void {
    this.peer?.deliver('message', { data });
  }

  close(code = 1005, reason = ''): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;

    if (this.peer === null) return;
    this.peer.readyState = WebSocket.CLOSED;
    this.peer.deliver('close', { code, reason });
  }

  private deliver(type: string, event: SocketEvent): void {
    queueMicrotask(() => {
      if (this.accepted) this.dispatch(type, event);
      else this.pending.push([type, event]);
    });
  }

  private dispatch(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function socketPair(): [PairedSocket, PairedSocket] {
  const a = new PairedSocket();
  const b = new PairedSocket();

  a.peer = b;
  b.peer = a;

  return [a, b];
}

/** A preview port whose server answers an upgrade with `target`, its keep-alive host, and the relay pairs made. */
function preview() {
  const made: [PairedSocket, PairedSocket][] = [];

  Reflect.set(globalThis, 'WebSocketPair', function WebSocketPair() {
    const pair = socketPair();

    made.push(pair);

    return pair;
  });

  const host: KeepaliveHost = {
    processes: { residentRunning: 1 }, _w1KeepaliveArmed: true, _w1LastClientActivityAt: 0, _w1OpenClientSockets: 0, _w1SessionDestroyed: false,
  };

  const [target, server] = socketPair();
  const ports = new PortRegistry();

  ports.setClientSockets({ opened: () => v.parse(v.function(), hibernation.holdResidentClient(host, () => undefined)) });
  // A routeable target answers HTTP as well; this one's page is never asked for.
  ports.bindFacetStub(41, {
    handleHttpRequest: async () => new Response('the preview page'),
    handleWebSocketRequest: async () => {
      const response = new Response(null, { status: 101 });

      Object.defineProperty(response, 'webSocket', { value: target });

      return response;
    },
  });
  ports.register(5173, 41);

  return { host, made, server, ports };
}

const fired = (host: KeepaliveHost, at: number): number | null => v.parse(v.nullable(v.number()), hibernation.residentKeepaliveFired(host, at));

describe('a preview WebSocket holds its dev server', () => {
  test('quiet past the 60 s bound, three times over, and let go once it closes and the bound passes', async () => {
    const { host, made, server, ports } = preview();
    const realNow = Date.now;
    let now = realNow();

    Date.now = () => now;

    try {
      const answer = await ports.routeRequest(5173, new Request('https://preview.invalid/@vite/client', { headers: { upgrade: 'websocket', connection: 'Upgrade' } }), '/@vite/client');

      expect(answer?.status).toBe(101);
      const [client] = made[0] ?? [];

      client?.accept();
      server.accept();

      for (let minute = 1; minute <= 3; minute++) {
        now += 61_000;
        expect(fired(host, now)).toBe(now + RESIDENT_KEEPALIVE_MS);
      }

      const closed = Promise.withResolvers<void>();

      server.addEventListener('close', () => { closed.resolve(); });
      client?.close(1001, 'tab closed');
      await closed.promise;
      await Promise.resolve();
      expect(host._w1OpenClientSockets).toBe(0);

      now += 61_000;
      expect(fired(host, now)).toBeNull();
    } finally {
      Date.now = realNow;
      Reflect.deleteProperty(globalThis, 'WebSocketPair');
    }
  });

  test('with no socket open, the bound is 0.17\'s: 60 s after the last client call', () => {
    const host: KeepaliveHost = {
      processes: { residentRunning: 1 }, _w1KeepaliveArmed: true, _w1LastClientActivityAt: 0, _w1OpenClientSockets: 0, _w1SessionDestroyed: false,
    };

    const realNow = Date.now;
    let now = realNow();

    Date.now = () => now;

    try {
      hibernation.noteResidentClient(host, () => undefined);
      now += 30_000;
      expect(fired(host, now)).toBe(now + RESIDENT_KEEPALIVE_MS);
      now += 61_000;
      expect(fired(host, now)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});
