/**
 * A workspace program's plain socket that may later ask for TLS (STARTTLS: pg, mysql2, nodemailer), carried by Kinu's
 * egress. Kinu's Nimbus patch (NIMBUS-ASKS #46) names every plain TCP socket a program opens under an egress
 * `<host>.k.<tags>.tcp.nimbus-egress.invalid:<port>`, each as the hex of its bytes in labels of at most 62 characters:
 * `<host>` its UTF-8, `<tags>` 32 random bytes, an ask tag and an answer tag. The name is the egress's alone; the server
 * sees neither tag. Bytes are carried as they are, read as a stream (any split, any join) for one thing: the server's
 * go-ahead to start TLS, the answer to PostgreSQL's SSLRequest, a MySQL greeting offering TLS, or the final reply line
 * to STARTTLS, STLS or AUTH TLS. The server is not read past a go-ahead until the program moves (workerd starts TLS only
 * on a connection with no read of it pending): the program's next bytes, or its close, decide. Only there, first (a
 * MySQL SSLRequest before it), is the program's ask read, `<ask tag> 'U' <n> <servername>`, and it is never passed on.
 * The session is made on the same connection to the server and answered once its handshake is done, as the first bytes
 * the program reads after its ask: `<answer tag> 1`, or `<answer tag> 0 <n:2> <reason>`. The server never sees the
 * answer tag, so it cannot write that answer; an ask anywhere else is refused at the start of a write, or carried as
 * bytes and left unanswered.
 */
import { renderThrownChain } from '@kinu.run/core/obs';

/** The two ends this carries between; workerd's `Socket` is one. */
export interface CarriedSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

/** The server's end: a connection made with `secureTransport: 'starttls'`. */
export interface UpgradableSocket extends CarriedSocket {
  startTls(options?: { readonly expectedServerHostname?: string }): CarriedSocket & { readonly opened: Promise<unknown> };
}

const KEYED_SOCKET_SUFFIX = '.tcp.nimbus-egress.invalid';

const TAG_LENGTH = 16;

const ASK_TLS = 0x55;

/** A keyed socket's two tags: the program's ask begins with one, the egress's answer with the other. */
export interface KeyedTags {
  readonly ask: Uint8Array;
  readonly answer: Uint8Array;
}

/** `labels` (hex, in dot-separated labels) as bytes; null when they are not hex. */
function hexLabels(labels: string | undefined): Uint8Array | null {
  const hex = labels?.split('.').join('') ?? '';

  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;

  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** The host and tags a keyed socket names (`<host>.k.<tags>.tcp.nimbus-egress.invalid`); null for any other name. */
export function keyedHost(hostname: string): { readonly hostname: string; readonly tags: KeyedTags } | null {
  if (!hostname.endsWith(KEYED_SOCKET_SUFFIX)) return null;
  const [host, tags, ...rest] = hostname.slice(0, -KEYED_SOCKET_SUFFIX.length).split('.k.');
  const name = hexLabels(host);
  const bytes = hexLabels(tags);

  if (name === null || bytes?.length !== 2 * TAG_LENGTH || rest.length > 0) return null;

  return { hostname: new TextDecoder().decode(name), tags: { ask: bytes.subarray(0, TAG_LENGTH), answer: bytes.subarray(TAG_LENGTH) } };
}

/** Whether `bytes` begins with `prefix`. */
function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, at) => bytes[at] === byte);
}

const PG_SSL_REQUEST = [0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f];

/** A program's line asking a text protocol for TLS: SMTP and IMAP STARTTLS, POP3 STLS, FTP AUTH TLS. */
const TEXT_STARTTLS = /^(?:\S+ )?(?:STARTTLS|STLS)\r?$|^AUTH TLS\r?$/i;

/** A server line that is not the reply's last: SMTP/FTP `NNN-`, IMAP's untagged `* `. */
const CONTINUED_LINE = /^(?:\d{3}-|\* )/;

/** Longer than any STARTTLS line, and than any MySQL greeting's first packet. */
const LINE_LIMIT = 64;

const GREETING_LIMIT = 1024;

const MYSQL_CLIENT_SSL = 0x0800;

const MYSQL_SSL_REQUEST_LENGTH = 36;

/** A MySQL server's first packet, whole (protocol 10), offering TLS: the client's next move may be its SSLRequest. */
function mysqlGreetingOffersTls(bytes: Uint8Array): boolean {
  const version = bytes.indexOf(0, 5);

  if (version < 0) return false;
  // Connection id (4), the scramble's first part (8) and a filler (1), then the low capability flags.
  const flags = version + 1 + 4 + 8 + 1;

  return (((bytes[flags] ?? 0) | ((bytes[flags + 1] ?? 0) << 8)) & MYSQL_CLIENT_SSL) !== 0;
}

/** Whether `bytes` are, or may still become, a MySQL client's SSLRequest: 32 bytes, sequence 1, asking for TLS. */
function mysqlSslRequest(bytes: Uint8Array): 'whole' | 'part' | null {
  const header = [32, 0, 0, 1];

  if (!header.every((byte, at) => at >= bytes.length || bytes[at] === byte)) return null;

  if (bytes.length < 6) return 'part';

  if ((((bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8)) & MYSQL_CLIENT_SSL) === 0) return null;

  return bytes.length >= MYSQL_SSL_REQUEST_LENGTH ? 'whole' : 'part';
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length);

  joined.set(first);
  joined.set(second, first.length);

  return joined;
}

function answer(tag: Uint8Array, refusal: string | null): Uint8Array {
  if (refusal === null) return concat(tag, Uint8Array.of(1));
  const reason = new TextEncoder().encode(refusal).subarray(0, 0xffff);

  return concat(concat(tag, Uint8Array.of(0, reason.length >> 8, reason.length & 0xff)), reason);
}

/**
 * What the two directions have said that a go-ahead depends on, read a byte at a time so no split or join of the stream
 * changes it: the program's first eight bytes (PostgreSQL's SSLRequest), its lines (a text STARTTLS, and how many replies
 * are owed), and the server's first packet (a MySQL greeting) and reply lines.
 */
class GoAheads {
  private readonly head: number[] = [];

  private line = '';

  private lines = 0;

  private replies = 0;

  private serverLine = '';

  private greeting: number[] | null = [];

  /** The server's next byte answers PostgreSQL's SSLRequest. */
  private byte = false;

  /** The program line whose reply is the go-ahead, by count. */
  private replyTo: number | null = null;

  /** The last go-ahead was a MySQL greeting: the program's SSLRequest may come before its ask. */
  mysql = false;

  /** The program's plaintext, carried. */
  sent(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (this.head.length < PG_SSL_REQUEST.length) {
        this.head.push(byte);
        this.byte ||= this.head.length === PG_SSL_REQUEST.length && PG_SSL_REQUEST.every((expected, at) => this.head[at] === expected);
      }

      if (byte !== 0x0a) {
        this.line = this.line.length > LINE_LIMIT ? this.line : this.line + String.fromCharCode(byte);
        continue;
      }

      this.lines += 1;

      if (TEXT_STARTTLS.test(this.line)) this.replyTo = this.lines;
      this.line = '';
    }
  }

  /** Where in the server's `bytes` a go-ahead ends (exclusive); -1 when none does. */
  goAheadEnd(bytes: Uint8Array): number {
    for (const [at, byte] of bytes.entries()) {
      if (this.greeting !== null && this.greetingEnds(byte)) return at + 1;

      if (this.byte) {
        this.byte = false;
        this.mysql = false;

        return at + 1;
      }

      if (byte !== 0x0a) {
        this.serverLine = this.serverLine.length >= 4 ? this.serverLine : this.serverLine + String.fromCharCode(byte);
        continue;
      }

      const final = !CONTINUED_LINE.test(this.serverLine);

      this.serverLine = '';

      // A reply answers a line the program sent; a server's own greeting answers none.
      if (final && this.replies < this.lines) this.replies += 1;

      if (final && this.replyTo !== null && this.replies === this.replyTo) {
        this.replyTo = null;
        this.mysql = false;

        return at + 1;
      }
    }

    return -1;
  }

  /** The server's first packet, a byte more of it: true where a MySQL greeting offering TLS ends. */
  private greetingEnds(byte: number): boolean {
    const greeting = this.greeting ?? [];

    greeting.push(byte);
    const length = greeting.length >= 3 ? (greeting[0] ?? 0) | ((greeting[1] ?? 0) << 8) | ((greeting[2] ?? 0) << 16) : 0;

    if ((greeting.length === 4 && byte !== 0) || (greeting.length === 5 && byte !== 0x0a) || length + 4 > GREETING_LIMIT) {
      this.greeting = null;

      return false;
    }

    if (greeting.length < 5 || greeting.length < length + 4) return false;
    this.greeting = null;
    this.mysql = mysqlGreetingOffersTls(Uint8Array.from(greeting));

    return this.mysql;
  }
}

/** A gate the server's reader waits at after a go-ahead, until the program moves. */
interface GoAheadGate {
  readonly passed: Promise<void>;
  open(): void;
}

function goAheadGate(): GoAheadGate {
  const { promise, resolve } = Promise.withResolvers<void>();

  return { passed: promise, open: () => { resolve(); } };
}

interface CarryState {
  gate: GoAheadGate | null;
  /** The server's bytes past its go-ahead, read in the same chunk: the program's once it goes on in plaintext. */
  past: Uint8Array;
  upgrading: boolean;
}

/**
 * Carry `program` to `server` (connected to `hostname`) until either ends, making the TLS session the program asks for
 * with `tags`. Resolves when the carrying ends; a refused or failed TLS session closes both ends.
 */
export async function carryKeyed(program: CarriedSocket, server: UpgradableSocket, hostname: string, tags: KeyedTags): Promise<void> {
  const toProgram = program.writable.getWriter();
  const fromProgram = program.readable.getReader();
  const toServer = server.writable.getWriter();
  const fromServer = server.readable.getReader();
  const goAheads = new GoAheads();
  // Shared by the two directions: `gate` holds the server's reader after a go-ahead. Only a reader parked at a go-ahead,
  // with nothing of the server's read past it, may be handed to TLS.
  const at: CarryState = { gate: null, past: new Uint8Array(0), upgrading: false };

  // The server's bytes to the program, none past a go-ahead until the program moves.
  const carrying = (async () => {
    for (;;) {
      if (at.gate !== null) await at.gate.passed;
      at.gate = null;

      if (at.upgrading) return;
      let value = at.past;

      at.past = new Uint8Array(0);

      if (value.length === 0) {
        const read = await fromServer.read();

        if (read.done) {
          await toProgram.close();

          return;
        }

        value = read.value;
      }

      const end = goAheads.goAheadEnd(value);

      if (end >= 0) {
        at.past = value.subarray(end);
        at.gate = goAheadGate();
      }

      await toProgram.write(end >= 0 ? value.subarray(0, end) : value);
    }
  })();

  // A failed end takes the other with it, so the loop below is not left reading a program nobody answers; what
  // failed is answered by the close, as the program's next read sees it.
  const down = (async () => {
    const [carried] = await Promise.allSettled([carrying]);

    if (carried.status === 'rejected') await Promise.allSettled([program.close(), server.close()]);
  })();

  const refuse = async (reason: string) => {
    at.upgrading = true;
    at.gate?.open();
    await toProgram.write(answer(tags.answer, reason));
    await Promise.allSettled([program.close(), server.close()]);
  };

  // The program's bytes to the server, as they are; an ask ends this loop and hands both ends to TLS.
  let held: Uint8Array = new Uint8Array(0);

  for (;;) {
    const { value, done } = await fromProgram.read();

    // The program's end of input is not passed on (`handleEgressConnect`); the server's own close ends the socket, and
    // what the server holds past a go-ahead is still the program's to read.
    if (done) {
      at.gate?.open();
      await down;

      return;
    }

    let bytes = concat(held, value);

    held = new Uint8Array(0);

    if (at.gate === null) {
      // An ask with no go-ahead to answer is refused where it starts a write; anything else is the program's bytes.
      if (startsWith(bytes, tags.ask)) {
        await refuse('Kinu\'s egress makes STARTTLS right after a PostgreSQL, MySQL or text-protocol (SMTP, IMAP, POP3, FTP) '
          + 'go-ahead; this connection\'s server gave no go-ahead when TLS was asked for');

        return;
      }

      goAheads.sent(bytes);
      await toServer.write(bytes);
      continue;
    }

    // At a go-ahead: a MySQL client's SSLRequest first, which is the server's, and the go-ahead stands.
    const ssl = goAheads.mysql ? mysqlSslRequest(bytes) : null;

    if (ssl === 'part') {
      held = bytes;
      continue;
    }

    if (ssl === 'whole') {
      goAheads.sent(bytes.subarray(0, MYSQL_SSL_REQUEST_LENGTH));
      await toServer.write(bytes.subarray(0, MYSQL_SSL_REQUEST_LENGTH));
      bytes = bytes.subarray(MYSQL_SSL_REQUEST_LENGTH);
      goAheads.mysql = false;
    }

    // Then the ask, held while its bytes may still become one: a client's first move after a go-ahead is TLS, or its
    // next command, never a shorter write that is the start of a 16-byte random tag.
    if (bytes.length < TAG_LENGTH ? startsWith(tags.ask, bytes) : startsWith(bytes, tags.ask)) {
      const ask = bytes.subarray(TAG_LENGTH);

      if (bytes.length < TAG_LENGTH || ask.length < 2 || ask.length < 2 + (ask[1] ?? 0)) {
        held = bytes;
        continue;
      }

      await upgrade(ask);

      return;
    }

    // The program went on in plaintext: the server's next bytes, and any it sent past the go-ahead, are its to read.
    goAheads.sent(bytes);
    await toServer.write(bytes);
    at.gate.open();
  }

  async function upgrade(ask: Uint8Array): Promise<void> {
    const servername = new TextDecoder().decode(ask.subarray(2, 2 + (ask[1] ?? 0))) || hostname;
    const after = ask.subarray(2 + (ask[1] ?? 0));

    if (ask[0] !== ASK_TLS) {
      await refuse('the egress was asked for something it does not make');

      return;
    }

    // A server that wrote past its go-ahead before TLS has put plaintext where the session's bytes should be.
    if (at.past.length > 0) {
      await refuse('the server sent more after its go-ahead, before TLS; a session over it would carry that plaintext as secure');

      return;
    }

    at.upgrading = true;
    at.gate?.open();
    await down;
    fromServer.releaseLock();
    toServer.releaseLock();
    // A server named other than its host is checked by that name (workerd's own node:tls does the same).
    const secure = servername === hostname ? server.startTls() : server.startTls({ expectedServerHostname: servername });

    // Answered only from the handshake's own result: the program is told TLS holds once it does.
    const [opened] = await Promise.allSettled([secure.opened]);

    if (opened.status === 'rejected') {
      await toProgram.write(answer(tags.answer, `the TLS session with ${servername} could not be made: ${renderThrownChain({ cause: opened.reason })}`));
      await Promise.allSettled([program.close(), secure.close()]);

      return;
    }

    await toProgram.write(answer(tags.answer, null));
    toProgram.releaseLock();
    fromProgram.releaseLock();

    if (after.length > 0) {
      const writer = secure.writable.getWriter();

      await writer.write(after);
      writer.releaseLock();
    }

    await Promise.all([program.readable.pipeTo(secure.writable, { preventClose: true }), secure.readable.pipeTo(program.writable)]);
  }
}
