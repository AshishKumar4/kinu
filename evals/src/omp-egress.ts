/**
 * The measured run's only way out: an HTTP proxy in this process that opens a tunnel to the hosts it allows and refuses
 * every other request, so a tool Plan permits (a web search, a fetch) reaches nothing but the model. Bun's fetch reads
 * `HTTPS_PROXY` and `HTTP_PROXY` at each call, so setting them routes every fetch here.
 */
import { connect, type Socket } from 'node:net';

const CONNECT = /^CONNECT ([^ \r\n]+) HTTP\/1\.[01]\r\n/u;

export interface Egress {
  /** Each destination refused, as it was asked for. */
  readonly refused: readonly string[];
  readonly stop: () => void;
}

/** Listens on 127.0.0.1, routes this process's fetches through it, and lets through only `allowed` (`host:port`). */
export function limitEgress(allowed: readonly string[]): Egress {
  const refused: string[] = [];
  const open = new Set(allowed);
  const tunnels = new WeakMap<object, Socket>();

  const server = Bun.listen({
    hostname: '127.0.0.1', port: 0,
    socket: {
      data(socket, data) {
        const tunnel = tunnels.get(socket);

        if (tunnel !== undefined) {
          tunnel.write(data);

          return;
        }

        const asked = CONNECT.exec(Buffer.from(data).toString('latin1'));
        const target = asked?.[1];

        if (target === undefined || !open.has(target)) {
          refused.push(target ?? Buffer.from(data).toString('latin1').split('\r\n')[0] ?? '');
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.end();

          return;
        }

        const [host = '', port = '443'] = target.split(':');
        const upstream = connect(Number(port), host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); });
        upstream.on('data', (chunk) => { socket.write(chunk); });
        upstream.on('close', () => { socket.end(); });
        upstream.on('error', () => { socket.end(); });
        tunnels.set(socket, upstream);
      },
      close(socket) {
        tunnels.get(socket)?.destroy();
      },
    },
  });

  const proxy = `http://127.0.0.1:${String(server.port)}`;
  const before = { https: process.env.HTTPS_PROXY, http: process.env.HTTP_PROXY };
  process.env.HTTPS_PROXY = proxy;
  process.env.HTTP_PROXY = proxy;

  return {
    refused,
    stop: () => {
      server.stop(true);

      if (before.https === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = before.https;

      if (before.http === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = before.http;
    },
  };
}
