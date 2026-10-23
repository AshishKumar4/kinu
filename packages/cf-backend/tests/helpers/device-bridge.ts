/**
 * The hub a real device daemon dials, in process: every `/pc/*` request goes through the Worker's own routes
 * (`pcRoutes`, core `http/pc-ingress.ts`) to the real UserDO the harness holds, and a socket's frames go both ways
 * between the daemon's WebSocket and the one the UserDO accepted, closes included. Every request the Worker and the
 * UserDO received is kept, so a test can assert what a connect put in a URL or a header.
 */
import * as v from 'valibot';
import { DEVICE_FRAMES, DEVICE_CONNECT_PATH } from '@kinu.run/core';
import { pcRoutes } from '../../src/pc-routes';
import { makeKv } from './kv';
import { TEST_USER_ENV, type AcceptedSocket, type TestUserDO } from './user-do';

/** A request as it reached the Worker or the UserDO: its line and its headers. */
export interface SeenRequest {
  readonly at: 'worker' | 'object';
  readonly method: string;
  readonly url: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

export interface DeviceBridge {
  readonly origin: string;
  /** Every request the Worker and then the UserDO received, in order. */
  readonly seen: SeenRequest[];
  /** Each connect ticket the Worker answered, as its body carried it. */
  readonly tickets: string[];
  /** Each socket's frames from the daemon, in order, per socket. */
  readonly frames: string[][];
  /** Resolves once the n-th socket (from 0) has said HELLO. */
  helloed(n: number): Promise<AcceptedSocket>;
  /** Resolves once a daemon has sent a frame `heard` matches, and the UserDO has handled it. */
  heard(heard: (frame: string) => boolean): Promise<void>;
  stop(): Promise<void>;
}

/** What a test answers beside `/pc/*`: the CLI's own routes, which the re-enrol case serves from the harness. */
export type BridgeRoutes = (request: Request) => Promise<Response | null>;

const TicketAnswerSchema = v.object({ ticket: v.string() });

function seen(at: SeenRequest['at'], request: Request): SeenRequest {
  return { at, method: request.method, url: request.url, headers: [...request.headers] };
}

export function startDeviceBridge(harness: TestUserDO, routes: BridgeRoutes = async () => null): DeviceBridge {
  const requests: SeenRequest[] = [];
  const tickets: string[] = [];
  const frames: string[][] = [];
  const helloes: Array<{ readonly promise: Promise<AcceptedSocket>; readonly resolve: (accepted: AcceptedSocket) => void }> = [];
  const nth = (n: number) => (helloes[n] ??= Promise.withResolvers<AcceptedSocket>());
  let helloed = 0;
  const listening: Array<{ readonly heard: (frame: string) => boolean; readonly resolve: () => void }> = [];

  const env = {
    ...TEST_USER_ENV,
    AUTH_KV: makeKv(),
    UserDO: {
      idFromName: (name: string) => name,
      get: () => ({
        issueDeviceConnectChallenge: harness.userDO.issueDeviceConnectChallenge.bind(harness.userDO),
        issueDeviceConnectTicket: harness.userDO.issueDeviceConnectTicket.bind(harness.userDO),
        recordDeviceUpdateRefusal: harness.userDO.recordDeviceUpdateRefusal.bind(harness.userDO),
        joinDevice: harness.userDO.joinDevice.bind(harness.userDO),
        fetch: async (request: Request) => {
          requests.push(seen('object', request));

          return harness.userDO.fetch(request);
        },
      }),
    },
  };

  const server = Bun.serve<{ accepted: AcceptedSocket; index: number }>({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, bun) {
      requests.push(seen('worker', request));
      const pathname = new URL(request.url).pathname;

      if (!pathname.startsWith('/pc/')) return await routes(request) ?? new Response('not found', { status: 404 });
      const answer = await pcRoutes.fetch(request, env);

      if (pathname === '/pc/connect-ticket' && answer.ok) {
        const issued = v.safeParse(TicketAnswerSchema, await answer.clone().json());

        if (issued.success) tickets.push(issued.output.ticket);
      }

      if (pathname !== DEVICE_CONNECT_PATH || answer.status !== 101) return answer;
      const accepted = harness.acceptedSockets.at(-1);

      if (accepted === undefined) throw new Error('the UserDO upgraded without accepting a socket');
      frames.push([]);

      return bun.upgrade(request, { data: { accepted, index: frames.length - 1 } }) ? undefined : new Response('upgrade failed', { status: 500 });
    },
    websocket: {
      open(ws) {
        ws.data.accepted.forward((data) => { ws.send(data); });
        ws.data.accepted.forwardClose((code, reason) => { ws.close(code, reason); });
      },
      async message(ws, message) {
        const data = String(message);

        await harness.userDO.webSocketMessage(ws.data.accepted.ws, data);
        // Kept once handled, so a test that read a frame here reads what the UserDO made of it too.
        frames[ws.data.index]?.push(data);

        for (const listener of listening.splice(0)) {
          if (listener.heard(data)) listener.resolve();
          else listening.push(listener);
        }

        if (v.is(v.object({ type: v.literal(DEVICE_FRAMES.hello) }), JSON.parse(data === 'ping' ? 'null' : data))) {
          nth(helloed).resolve(ws.data.accepted);
          helloed += 1;
        }
      },
      async close(ws, code, reason) {
        if (ws.data.accepted.closed() !== null) return;
        ws.data.accepted.drop();
        await harness.userDO.webSocketClose(ws.data.accepted.ws, code, reason, true);
      },
    },
  });

  return {
    origin: `http://127.0.0.1:${String(server.port)}`,
    seen: requests,
    tickets,
    frames,
    helloed: (n) => nth(n).promise,
    heard: (heard) => {
      if (frames.flat().some(heard)) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();

      listening.push({ heard, resolve });

      return promise;
    },
    stop: () => server.stop(true),
  };
}
