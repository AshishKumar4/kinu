// STARTTLS through Kinu's egress: a keyed socket carried as it is until the program asks for TLS, then the session made
// on the same connection to the server. The fake server refuses `startTls` while a read of it is pending, as workerd does.
import { describe, expect, test } from 'bun:test';
import { carryKeyed, keyedHost, type CarriedSocket, type UpgradableSocket } from '../src/egress/keyed-socket';

const KEY = {
  ask: Uint8Array.of(0xa0, 0x32, 0xeb, 0x49, 0x04, 0xc7, 0x91, 0x55, 0xe2, 0x0d, 0x72, 0xaa, 0x08, 0xdf, 0x64, 0xb3),
  answer: Uint8Array.of(0x5c, 0x17, 0x88, 0xd0, 0x3e, 0x91, 0x2b, 0xf4, 0x60, 0xa9, 0x0e, 0x7d, 0xc3, 0x46, 0xb8, 0x1f),
};

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);

function ask(servername = ''): Uint8Array {
  const name = bytesOf(servername);

  return Uint8Array.from([...KEY.ask, 0x55, name.length, ...name]);
}

/** One end's bytes as they arrive, read on demand. */
class Inbox {
  private held = new Uint8Array(0);

  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  /** Exactly `count` bytes. */
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

  async ended(): Promise<boolean> {
    const { done } = await this.reader.read();

    return done;
  }
}

interface Pipe {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

function pipe(): Pipe {
  return new TransformStream<Uint8Array, Uint8Array>();
}

interface SecureEnd {
  readonly heard: Inbox;
  send(value: string): Promise<void>;
  end(): Promise<void>;
}

/** The secure session a fake server made, once `startTls` was called. */
interface MadeSession {
  end: SecureEnd | null;
}

interface FakeServer {
  readonly socket: UpgradableSocket;
  readonly heard: Inbox;
  send(value: string | Uint8Array): Promise<void>;
  end(): Promise<void>;
  /** The names `startTls` was asked to check, once per call. */
  readonly upgrades: (string | undefined)[];
  /** Every plaintext byte the server was sent so far. */
  received(): Uint8Array;
  /** The secure session's ends, once made. */
  secure(): SecureEnd;
}

/** A server end that refuses `startTls` while a read of it is pending or its streams are locked, as workerd does. */
function fakeServer(options: { readonly refuseTls?: Error } = {}): FakeServer {
  const sent: number[] = [];

  const toServer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sent.push(...chunk);
      controller.enqueue(chunk);
    },
  });

  const fromServer = pipe();
  const source = fromServer.readable.getReader();
  const reads = { pending: false };

  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      reads.pending = true;
      const { value, done } = await source.read();

      reads.pending = false;

      if (done) controller.close();
      else controller.enqueue(value);
    },
  }, { highWaterMark: 0 });

  const writer = fromServer.writable.getWriter();
  const upgrades: (string | undefined)[] = [];
  const made: MadeSession = { end: null };

  const socket: UpgradableSocket = {
    readable,
    writable: toServer.writable,
    close: async () => {},
    startTls: (tlsOptions) => {
      if (reads.pending) throw new TypeError('Cannot call releaseLock() on a reader with outstanding read promises.');

      if (readable.locked || toServer.writable.locked) throw new TypeError('The ReadableStream has been locked to a reader.');

      upgrades.push(tlsOptions?.expectedServerHostname);
      const secureIn = pipe();
      const secureOut = pipe();
      const secureWriter = secureOut.writable.getWriter();

      made.end = { heard: new Inbox(secureIn.readable), send: (value) => secureWriter.write(bytesOf(value)), end: () => secureWriter.close() };

      return {
        readable: secureOut.readable, writable: secureIn.writable, close: async () => {},
        opened: options.refuseTls === undefined ? Promise.resolve({}) : Promise.reject(options.refuseTls),
      };
    },
  };

  return {
    socket,
    heard: new Inbox(toServer.readable),
    send: (value) => writer.write(typeof value === 'string' ? bytesOf(value) : value),
    end: () => writer.close(),
    upgrades,
    received: () => Uint8Array.from(sent),
    secure: () => {
      if (made.end === null) throw new Error('no TLS session was made');

      return made.end;
    },
  };
}

interface FakeProgram {
  readonly socket: CarriedSocket;
  readonly heard: Inbox;
  send(value: string | Uint8Array): Promise<void>;
  end(): Promise<void>;
}

function fakeProgram(): FakeProgram {
  const toProgram = pipe();
  const fromProgram = pipe();
  const writer = fromProgram.writable.getWriter();

  return {
    socket: { readable: fromProgram.readable, writable: toProgram.writable, close: async () => {} },
    heard: new Inbox(toProgram.readable),
    send: (value) => writer.write(typeof value === 'string' ? bytesOf(value) : value),
    end: () => writer.close(),
  };
}

const PG_SSL_REQUEST = Uint8Array.of(0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f);

/** A MySQL 8 greeting (protocol 10) whose capability flags offer TLS. */
function mysqlGreeting(): Uint8Array {
  const body = [0x0a, ...bytesOf('8.0.36'), 0, 1, 0, 0, 0, ...Array.from({ length: 8 }, () => 0x41), 0, 0xff, 0xff, 0x21, 2, 0];

  return Uint8Array.from([body.length, 0, 0, 0, ...body]);
}

/** A MySQL client's SSLRequest: 32 bytes, sequence 1, CLIENT_SSL among its flags. */
function mysqlSslRequest(): Uint8Array {
  return Uint8Array.from([32, 0, 0, 1, 0x00, 0x0a, 0x0f, 0x00, ...Array.from({ length: 28 }, () => 0)]);
}

describe('a keyed socket names its host and tags', () => {
  test('the egress reads both back, and refuses any other shape', () => {
    const hex = (value: Uint8Array): string => [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');

    // 32 bytes of tags are 64 hex characters, past a DNS label's 63: two labels, as the shims spell them.
    const tags = hex(Uint8Array.from([...KEY.ask, ...KEY.answer]));

    expect(keyedHost(`${hex(bytesOf('db.example.com'))}.k.${tags.slice(0, 62)}.${tags.slice(62)}.tcp.nimbus-egress.invalid`))
      .toEqual({ hostname: 'db.example.com', tags: KEY });
    expect(keyedHost(`${hex(bytesOf('db.example.com'))}.k.${hex(KEY.ask)}.tcp.nimbus-egress.invalid`)).toBeNull();
    expect(keyedHost(`${hex(bytesOf('db.example.com'))}.k.abcd.tcp.nimbus-egress.invalid`)).toBeNull();
    expect(keyedHost('db.example.com')).toBeNull();
  });
});

describe('STARTTLS through the egress', () => {
  test('after a PostgreSQL go-ahead the server is left unread, and the session is made on the same connection', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'db.example.com', KEY);

    await program.send(PG_SSL_REQUEST);
    expect(await server.heard.take(8)).toEqual(PG_SSL_REQUEST);
    await server.send('S');
    expect(text(await program.heard.take(1))).toBe('S');
    await program.send(ask());
    expect(await program.heard.take(17)).toEqual(Uint8Array.from([...KEY.answer, 1]));
    expect(server.upgrades).toEqual([undefined]);

    await program.send('startup');
    expect(text(await server.secure().heard.take(7))).toBe('startup');
    await server.secure().send('ready');
    expect(text(await program.heard.take(5))).toBe('ready');
    await program.end();
    await server.secure().end();
    await carried;
  });

  test('after a MySQL greeting offering TLS and the client\'s SSLRequest, the session checks the name the client gave', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, '10.0.0.9', KEY);
    const greeting = mysqlGreeting();

    await server.send(greeting);
    expect(await program.heard.take(greeting.length)).toEqual(greeting);
    await program.send(Uint8Array.from([...mysqlSslRequest(), ...ask('db.example.com')]));
    expect(await server.heard.take(36)).toEqual(mysqlSslRequest());
    expect(await program.heard.take(17)).toEqual(Uint8Array.from([...KEY.answer, 1]));
    expect(server.upgrades).toEqual(['db.example.com']);
    await program.end();
    await server.secure().end();
    await carried;
  });

  test('after an SMTP server answers STARTTLS, the session is made; the lines before it pass as they are', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'smtp.example.com', KEY);

    await server.send('220 hello\r\n');
    expect(text(await program.heard.take(11))).toBe('220 hello\r\n');
    await program.send('EHLO kinu\r\n');
    expect(text(await server.heard.take(11))).toBe('EHLO kinu\r\n');
    await server.send('250 ok\r\n');
    expect(text(await program.heard.take(8))).toBe('250 ok\r\n');
    await program.send('STARTTLS\r\n');
    expect(text(await server.heard.take(10))).toBe('STARTTLS\r\n');
    await server.send('220 go ahead\r\n');
    expect(text(await program.heard.take(14))).toBe('220 go ahead\r\n');
    await program.send(ask());
    expect(await program.heard.take(17)).toEqual(Uint8Array.from([...KEY.answer, 1]));
    await program.send('EHLO kinu\r\n');
    expect(text(await server.secure().heard.take(11))).toBe('EHLO kinu\r\n');
    await program.end();
    await server.secure().end();
    await carried;
  });

  test('a PostgreSQL server that declines TLS is read on as before, when the program goes on in plaintext', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'db.example.com', KEY);

    await program.send(PG_SSL_REQUEST);
    await server.heard.take(8);
    await server.send('N');
    expect(text(await program.heard.take(1))).toBe('N');
    await program.send('startup');
    expect(text(await server.heard.take(7))).toBe('startup');
    await server.send('R');
    expect(text(await program.heard.take(1))).toBe('R');
    await program.end();
    await server.end();
    await carried;
  });

  test('TLS without a go-ahead is refused even while a server reply is waiting for the program', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'example.com', KEY);

    await program.send('PING\r\n');
    await server.heard.take(6);
    await server.send('+PONG\r\n');
    await program.send(ask());
    expect(text(await program.heard.take(7))).toBe('+PONG\r\n');

    const head = await program.heard.take(17);
    let refusal = '';

    if (head[16] === 0) {
      const length = await program.heard.take(2);

      refusal = text(await program.heard.take(((length[0] ?? 0) << 8) | (length[1] ?? 0)));
    } else {
      await program.end();
      await server.secure().end();
    }

    await carried;
    expect(head).toEqual(Uint8Array.from([...KEY.answer, 0]));
    expect(refusal).toContain('STARTTLS right after');
    expect(server.upgrades).toEqual([]);
  });

  test('a TLS session the server refuses is answered with its reason', async () => {
    const program = fakeProgram();
    const server = fakeServer({ refuseTls: new Error('certificate has expired') });
    const carried = carryKeyed(program.socket, server.socket, 'db.example.com', KEY);

    await program.send(PG_SSL_REQUEST);
    await server.heard.take(8);
    await server.send('S');
    await program.heard.take(1);
    await program.send(ask());

    const head = await program.heard.take(19);

    expect(head[16]).toBe(0);
    expect(text(await program.heard.take(((head[17] ?? 0) << 8) | (head[18] ?? 0)))).toContain('certificate has expired');
    await carried;
  });

  test('bytes that name no key pass both ways unchanged, and the server\'s close reaches the program', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'example.com', KEY);
    const binary = Uint8Array.from({ length: 4096 }, (_, at) => at % 251);

    await program.send(binary);
    expect(await server.heard.take(binary.length)).toEqual(binary);
    await server.send(binary);
    expect(await program.heard.take(binary.length)).toEqual(binary);
    await program.end();
    await server.end();
    await carried;
    expect(await program.heard.ended()).toBe(true);
  });
});

describe('the STARTTLS control cannot be forged by the server', () => {
  // The security review's probe (job 20261012120733-ce850ba3): an ask split 7/11 reached the server, which answered with
  // the key and 1; the program took that as TLS and sent its application data in plaintext.
  test('an ask split across writes never reaches the server, and only the real session answers it', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'db.example.com', KEY);
    const whole = ask();

    await program.send(PG_SSL_REQUEST);
    await server.heard.take(8);
    await server.send('S');
    await program.heard.take(1);
    await program.send(whole.subarray(0, 7));
    await program.send(whole.subarray(7));
    expect(await program.heard.take(17)).toEqual(Uint8Array.from([...KEY.answer, 1]));
    expect(server.upgrades).toEqual([undefined]);

    await program.send('authenticated application data');
    expect(text(await server.secure().heard.take(30))).toBe('authenticated application data');
    await program.end();
    await server.secure().end();
    await carried;
    expect(server.received()).toEqual(PG_SSL_REQUEST);
  });

  test('the answer the program trusts carries nothing the program sends', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'db.example.com', KEY);
    const asked = ask();

    await program.send(PG_SSL_REQUEST);
    await server.heard.take(8);
    await server.send('S');
    await program.heard.take(1);
    await program.send(asked);
    const head = await program.heard.take(16);

    await program.end();
    await server.secure().end();
    await carried;

    const sent = [...PG_SSL_REQUEST, ...asked];
    const within = sent.some((_, at) => head.every((byte, offset) => sent[at + offset] === byte));

    expect(within).toBe(false);
  });
});

describe('the carried stream is read in any split', () => {
  /** `bytes` sent one piece at a time, cut at `cuts`. */
  async function inPieces(send: (bytes: Uint8Array) => Promise<void>, bytes: Uint8Array, cuts: readonly number[]): Promise<void> {
    let from = 0;

    for (const cut of [...cuts, bytes.length]) {
      await send(bytes.subarray(from, cut));
      from = cut;
    }
  }

  /** Every byte apart: `bytes` cut after each one. */
  const everyByte = (bytes: Uint8Array): number[] => Array.from({ length: bytes.length - 1 }, (_, at) => at + 1);

  // 2026-10-12 review: a line of 64 characters or more (an IMAP tag) was cut off before STARTTLS could be read in it.
  test('an IMAP STARTTLS under a 200-character tag, sent a byte at a time, gets its go-ahead', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'imap.example.com', KEY);
    const tag = 'a'.repeat(200);
    const command = bytesOf(`${tag} STARTTLS\r\n`);

    await server.send('* OK ready\r\n');
    await program.heard.take(12);
    const sending = inPieces((bytes) => program.send(bytes), command, everyByte(command));

    await server.heard.take(command.length);
    await sending;
    const replies = `* CAPABILITY IMAP4rev1\r\n${tag} OK Begin TLS\r\n`;

    await server.send(replies);
    await program.heard.take(replies.length);
    await program.send(ask());
    expect(await program.heard.take(17)).toEqual(Uint8Array.from([...KEY.answer, 1]));
    await program.end();
    await server.secure().end();
    await carried;
  });

  // 2026-10-12 review: a greeting longer than 1,024 bytes was given up on, so its go-ahead was never seen.
  test('a MySQL greeting with a long version, sent a byte at a time, is the go-ahead', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, '10.0.0.9', KEY);
    const body = [0x0a, ...bytesOf(`8.0.36-${'x'.repeat(1500)}`), 0, 1, 0, 0, 0, ...Array.from({ length: 8 }, () => 0x41), 0, 0xff, 0xff, 0x21, 2, 0];
    const greeting = Uint8Array.from([body.length & 0xff, (body.length >> 8) & 0xff, 0, 0, ...body]);

    const greeted = inPieces((bytes) => server.send(bytes), greeting, everyByte(greeting));

    expect(await program.heard.take(greeting.length)).toEqual(greeting);
    await greeted;
    await program.send(Uint8Array.from([...mysqlSslRequest(), ...ask('db.example.com')]));
    expect(await server.heard.take(36)).toEqual(mysqlSslRequest());
    expect(await program.heard.take(17)).toEqual(Uint8Array.from([...KEY.answer, 1]));
    await program.end();
    await server.secure().end();
    await carried;
  });

  test('a PostgreSQL SSLRequest split 3/5 still makes the server\'s answer the go-ahead', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'db.example.com', KEY);

    const sending = inPieces((bytes) => program.send(bytes), PG_SSL_REQUEST, [3]);

    expect(await server.heard.take(8)).toEqual(PG_SSL_REQUEST);
    await sending;
    await server.send('S');
    await program.heard.take(1);
    await program.send(ask());
    expect(await program.heard.take(17)).toEqual(Uint8Array.from([...KEY.answer, 1]));
    await program.end();
    await server.secure().end();
    await carried;
  });

  test('a MySQL greeting split in three, and an SSLRequest split from its ask, still upgrade', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, '10.0.0.9', KEY);
    const greeting = mysqlGreeting();

    const greeted = inPieces((bytes) => server.send(bytes), greeting, [2, 9]);

    expect(await program.heard.take(greeting.length)).toEqual(greeting);
    await greeted;
    const asking = inPieces((bytes) => program.send(bytes), Uint8Array.from([...mysqlSslRequest(), ...ask('db.example.com')]), [20, 40]);

    expect(await server.heard.take(36)).toEqual(mysqlSslRequest());
    expect(await program.heard.take(17)).toEqual(Uint8Array.from([...KEY.answer, 1]));
    await asking;
    expect(server.upgrades).toEqual(['db.example.com']);
    await program.end();
    await server.secure().end();
    await carried;
  });

  test('pipelined SMTP: the go-ahead is the final reply to STARTTLS, not a continuation line or an earlier reply', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'smtp.example.com', KEY);

    await server.send('220 hello\r\n');
    await program.heard.take(11);
    await program.send('EHLO kinu\r\nSTARTTLS\r\n');
    await server.heard.take(21);
    const replied = inPieces((bytes) => server.send(bytes), bytesOf('250-size\r\n250 ok\r\n220 go ahead\r\n'), [4, 13]);

    expect(text(await program.heard.take(32))).toBe('250-size\r\n250 ok\r\n220 go ahead\r\n');
    await replied;
    await program.send(ask());
    expect(await program.heard.take(17)).toEqual(Uint8Array.from([...KEY.answer, 1]));
    await program.end();
    await server.secure().end();
    await carried;
  });

  test('a server that writes past its go-ahead before TLS is refused the session', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'db.example.com', KEY);

    await program.send(PG_SSL_REQUEST);
    await server.heard.take(8);
    await server.send('Sinjected');
    expect(text(await program.heard.take(1))).toBe('S');
    await program.send(ask());

    const head = await program.heard.take(19);

    expect(head.subarray(0, 17)).toEqual(Uint8Array.from([...KEY.answer, 0]));
    expect(text(await program.heard.take(((head[17] ?? 0) << 8) | (head[18] ?? 0)))).toContain('sent more after its go-ahead');
    expect(server.upgrades).toEqual([]);
    await carried;
  });

  test('a program that goes on in plaintext after a go-ahead reads what the server sent past it', async () => {
    const program = fakeProgram();
    const server = fakeServer();
    const carried = carryKeyed(program.socket, server.socket, 'db.example.com', KEY);

    await program.send(PG_SSL_REQUEST);
    await server.heard.take(8);
    await server.send('NR');
    expect(text(await program.heard.take(1))).toBe('N');
    await program.send('startup');
    expect(text(await server.heard.take(7))).toBe('startup');
    expect(text(await program.heard.take(1))).toBe('R');
    await program.end();
    await server.end();
    await carried;
  });
});
