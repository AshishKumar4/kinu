// A workspace program's TLS socket through Kinu's egress: the carrier's request names the host, the egress judges it and
// makes the session, and the program hears 1 only once the server's handshake succeeded, or why it did not.
import { describe, expect, test } from 'bun:test';
import { carryTls, type CarriedSocket, type StartableSocket } from '../src/egress/tls-carrier';

const encoder = new TextEncoder();

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function request(host: string, servername = ''): Uint8Array {
  const name = encoder.encode(host);
  const sni = encoder.encode(servername);

  return Uint8Array.from([0x54, name.length >> 8, name.length & 0xff, ...name, sni.length >> 8, sni.length & 0xff, ...sni]);
}

/** One end's bytes as they arrive, read on demand. */
class Inbox {
  private held = new Uint8Array(0);

  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  async take(count: number): Promise<Uint8Array> {
    while (this.held.length < count) {
      const { value, done } = await this.reader.read();

      if (done) throw new Error(`ended with ${String(this.held.length)} of ${String(count)} bytes`);
      this.held = Uint8Array.from([...this.held, ...value]);
    }

    const taken = this.held.subarray(0, count);

    this.held = this.held.subarray(count);

    return taken;
  }

  /** A refusal's reason: `0 <n:2> <reason>`. */
  async refusal(): Promise<string> {
    const head = await this.take(3);

    expect(head[0]).toBe(0);

    return text(await this.take(((head[1] ?? 0) << 8) | (head[2] ?? 0)));
  }
}

interface Ends {
  readonly socket: CarriedSocket;
  readonly heard: Inbox;
  send(value: string | Uint8Array): Promise<void>;
  end(): Promise<void>;
  readonly closed: { done: boolean };
}

/** A socket's two pipes: what the far side sends it, and what it sends there. */
function ends(): Ends {
  const inward = new TransformStream<Uint8Array, Uint8Array>();
  const outward = new TransformStream<Uint8Array, Uint8Array>();
  const writer = inward.writable.getWriter();
  const closed = { done: false };

  return {
    socket: { readable: inward.readable, writable: outward.writable, close: async () => { closed.done = true; } },
    heard: new Inbox(outward.readable),
    send: (value) => writer.write(typeof value === 'string' ? encoder.encode(value) : value),
    end: () => writer.close(),
    closed,
  };
}

interface Server {
  readonly connected: { hostname: string; port: number }[];
  readonly checked: (string | undefined)[];
  readonly session: Ends;
  readonly connect: (target: { readonly hostname: string; readonly port: number }) => StartableSocket;
}

function server(handshake: Promise<unknown> = Promise.resolve({})): Server {
  const connected: { hostname: string; port: number }[] = [];
  const checked: (string | undefined)[] = [];
  const session = ends();

  return {
    connected,
    checked,
    session,
    connect: (target) => {
      connected.push({ ...target });
      const plain = ends();

      return {
        ...plain.socket,
        startTls: (options) => {
          checked.push(options?.expectedServerHostname);

          return { ...session.socket, opened: handshake };
        },
      };
    },
  };
}

const allowed = () => null;

describe('a TLS carrier through the egress', () => {
  test('hears 1 once the server\'s session is made, then carries its plaintext both ways', async () => {
    const program = ends();
    const tls = server();
    const carried = carryTls(program.socket, { port: 443, refused: allowed, connect: tls.connect });

    await program.send(request('example.com'));
    expect(await program.heard.take(1)).toEqual(Uint8Array.of(1));
    expect(tls.connected).toEqual([{ hostname: 'example.com', port: 443 }]);
    expect(tls.checked).toEqual([undefined]);

    await program.send('GET / HTTP/1.1\r\n\r\n');
    expect(text(await tls.session.heard.take(18))).toBe('GET / HTTP/1.1\r\n\r\n');
    await tls.session.send('HTTP/1.1 200 OK');
    expect(text(await program.heard.take(15))).toBe('HTTP/1.1 200 OK');
    await program.end();
    await tls.session.end();
    await carried;
  });

  test('checks the server by the servername the program gave, and carries a host past 255 bytes', async () => {
    const program = ends();
    const tls = server();
    const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example`;
    const carried = carryTls(program.socket, { port: 8443, refused: allowed, connect: tls.connect });

    await program.send(request(host, 'api.example.com'));
    expect(await program.heard.take(1)).toEqual(Uint8Array.of(1));
    expect(tls.connected).toEqual([{ hostname: host, port: 8443 }]);
    expect(tls.checked).toEqual(['api.example.com']);
    await program.end();
    await tls.session.end();
    await carried;
  });

  test('a handshake the server fails is the program\'s answer, before any plaintext', async () => {
    const program = ends();
    const tls = server(Promise.reject(new Error('certificate has expired')));
    const carried = carryTls(program.socket, { port: 443, refused: allowed, connect: tls.connect });

    await program.send(request('expired.example.com'));
    expect(await program.heard.refusal()).toContain('certificate has expired');
    await carried;
    expect(program.closed.done).toBe(true);
  });

  test('a refused host is answered with why, and no connection is made', async () => {
    const program = ends();
    const tls = server();
    const carried = carryTls(program.socket, { port: 443, refused: (host) => `blocked private/internal address: ${host}`, connect: tls.connect });

    await program.send(request('10.0.0.1'));
    expect(await program.heard.refusal()).toBe('blocked private/internal address: 10.0.0.1');
    await carried;
    expect(tls.connected).toEqual([]);
  });

  test('bytes that are not a TLS request are refused', async () => {
    const program = ends();
    const tls = server();
    const carried = carryTls(program.socket, { port: 443, refused: allowed, connect: tls.connect });

    await program.send('GET / HTTP/1.1\r\n\r\n');
    expect(await program.heard.refusal()).toContain('no TLS request');
    await carried;
    expect(tls.connected).toEqual([]);
  });
});
