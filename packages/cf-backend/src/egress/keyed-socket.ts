/**
 * A workspace program's plain socket that may later ask for TLS (STARTTLS: pg, mysql2, nodemailer), carried by Kinu's
 * egress. Kinu's Nimbus patch (NIMBUS-ASKS #37) names every plain TCP socket a program opens under an egress
 * `<host>.k.<key>.tcp.nimbus-egress.invalid:<port>`, `<host>` as the hex of its UTF-8 in labels of at most 62 characters
 * and `<key>` 16 random bytes in hex. Its bytes are carried as they are until the program writes
 * `<key> 'U' <n> <servername>`: the TLS session is then made here, on the same connection to the server, answered
 * `<key> 1` (or `<key> 0 <n:2> <reason>`), and its plaintext carried from then on.
 *
 * workerd starts TLS only on a connection with no read of it pending (a reader with one cannot be released, and a pipe
 * that is stopped errors its source), so the server is not read past a STARTTLS go-ahead until the program moves:
 * PostgreSQL's answer to an SSLRequest, a MySQL greeting offering TLS, and a text protocol's answer to STARTTLS, STLS or
 * AUTH TLS. A program that asks for TLS anywhere else is answered with why, and the connection closed.
 */

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

const KEY_LENGTH = 16;

const ASK_TLS = 0x55;

/** Long enough for any program to move after a go-ahead; a server read is resumed after it rather than held for good. */
const GO_AHEAD_HOLD_MS = 10_000;

/** `labels` (hex, in dot-separated labels) as bytes; null when they are not hex. */
export function hexLabels(labels: string | undefined): Uint8Array | null {
  const hex = labels?.split('.').join('') ?? '';

  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;

  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** The host and key a keyed socket names (`<host>.k.<key>.tcp.nimbus-egress.invalid`); null for any other name. */
export function keyedHost(hostname: string): { readonly hostname: string; readonly key: Uint8Array } | null {
  if (!hostname.endsWith(KEYED_SOCKET_SUFFIX)) return null;
  const [host, key, ...rest] = hostname.slice(0, -KEYED_SOCKET_SUFFIX.length).split('.k.');
  const name = hexLabels(host);
  const bytes = hexLabels(key);

  return name === null || bytes?.length !== KEY_LENGTH || rest.length > 0 ? null : { hostname: new TextDecoder().decode(name), key: bytes };
}

function indexOfKey(bytes: Uint8Array, key: Uint8Array): number {
  for (let at = bytes.indexOf(key[0] ?? 0); at >= 0 && at + key.length <= bytes.length; at = bytes.indexOf(key[0] ?? 0, at + 1)) {
    if (key.every((byte, offset) => bytes[at + offset] === byte)) return at;
  }

  return -1;
}

const PG_SSL_REQUEST = [0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f];

const TEXT_STARTTLS = /^(?:\S+ )?(?:STARTTLS|STLS)\r?\n$|^AUTH TLS\r?\n$/i;

const MYSQL_CLIENT_SSL = 0x0800;

/** What answer a program's write asks the server for before it starts TLS: PostgreSQL's one byte, or a text line. */
function startTlsRequest(bytes: Uint8Array): 'byte' | 'line' | null {
  if (bytes.length === PG_SSL_REQUEST.length && PG_SSL_REQUEST.every((byte, at) => bytes[at] === byte)) return 'byte';

  return bytes.length <= 64 && TEXT_STARTTLS.test(new TextDecoder().decode(bytes)) ? 'line' : null;
}

/** A MySQL server's first packet (protocol 10) offering TLS: the client's next move may be its SSLRequest. */
function mysqlGreetingOffersTls(bytes: Uint8Array): boolean {
  const length = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) | ((bytes[2] ?? 0) << 16);
  const version = bytes.indexOf(0, 5);

  if (bytes[3] !== 0 || bytes[4] !== 0x0a || length + 4 !== bytes.length || version < 0) return false;
  // Connection id (4), the scramble's first part (8) and a filler (1), then the low capability flags.
  const flags = version + 1 + 4 + 8 + 1;

  return (((bytes[flags] ?? 0) | ((bytes[flags + 1] ?? 0) << 8)) & MYSQL_CLIENT_SSL) !== 0;
}

/** A MySQL client's SSLRequest: a 32-byte packet, sequence 1, asking for TLS. */
function mysqlSslRequest(bytes: Uint8Array): boolean {
  return bytes.length === 36 && bytes[0] === 32 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 1
    && (((bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8)) & MYSQL_CLIENT_SSL) !== 0;
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length);

  joined.set(first);
  joined.set(second, first.length);

  return joined;
}

function answer(key: Uint8Array, refusal: string | null): Uint8Array {
  if (refusal === null) return concat(key, Uint8Array.of(1));
  const reason = new TextEncoder().encode(refusal).subarray(0, 0xffff);

  return concat(concat(key, Uint8Array.of(0, reason.length >> 8, reason.length & 0xff)), reason);
}

/** A gate the server's reader waits at after a go-ahead, until the program moves (or the hold ends). */
interface GoAheadGate {
  readonly passed: Promise<void>;
  open(): void;
}

function goAheadGate(): GoAheadGate {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, GO_AHEAD_HOLD_MS);

  return { passed: promise, open: () => { clearTimeout(timer); resolve(); } };
}

interface CarryState {
  gate: GoAheadGate | null;
  awaited: 'byte' | 'line' | null;
  first: boolean;
  reading: boolean;
  upgrading: boolean;
}

/**
 * Carry `program` to `server` (connected to `hostname`) until either ends, making the TLS session the program asks for
 * with `key`. Resolves when the carrying ends; a refused or failed TLS session closes both ends.
 */
export async function carryKeyed(program: CarriedSocket, server: UpgradableSocket, hostname: string, key: Uint8Array): Promise<void> {
  const toProgram = program.writable.getWriter();
  const fromProgram = program.readable.getReader();
  const toServer = server.writable.getWriter();
  const fromServer = server.readable.getReader();
  // Shared by the two directions: `gate` holds the server's reader after a go-ahead, `awaited` is the answer the
  // program's last write asked for, `reading` is true while a read of the server is pending.
  const at: CarryState = { gate: null, awaited: null, first: true, reading: false, upgrading: false };

  // The server's bytes to the program, one read at a time, none past a go-ahead until the program moves.
  const down = (async () => {
    for (;;) {
      if (at.gate !== null) await at.gate.passed;
      at.gate = null;

      if (at.upgrading) return;
      at.reading = true;
      const { value, done } = await fromServer.read();
      at.reading = false;

      if (done) {
        await toProgram.close();

        return;
      }

      const goAhead = at.awaited === 'byte' || (at.awaited === 'line' && value.at(-1) === 0x0a) || (at.first && mysqlGreetingOffersTls(value));

      at.first = false;

      if (goAhead) {
        at.awaited = null;
        at.gate = goAheadGate();
      }

      await toProgram.write(value);
    }
  })();

  // A failed end takes the other with it, so the loop below is not left reading a program nobody answers.
  down.catch(() => Promise.allSettled([program.close(), server.close()]));

  // The program's bytes to the server, watched for its key; an upgrade ends this loop and hands both ends to TLS.
  let held: Uint8Array | null = null;

  for (;;) {
    const { value, done } = await fromProgram.read();

    // The program's end of input is not passed on (`handleEgressConnect`); the server's own close ends the socket.
    if (done) {
      await down;

      return;
    }

    const bytes: Uint8Array = held === null ? value : concat(held, value);
    const found = indexOfKey(bytes, key);
    const plain = found < 0 ? bytes : bytes.subarray(0, found);

    if (plain.length > 0) {
      at.awaited = startTlsRequest(plain) ?? at.awaited;
      await toServer.write(plain);

      // The program went on in plaintext: the server's next bytes are its to read. Its MySQL SSLRequest is not.
      if (at.gate !== null && !mysqlSslRequest(plain) && at.awaited === null) at.gate.open();
    }

    if (found < 0) continue;
    const ask = bytes.subarray(found + key.length);

    // The ask arrives in one write; held only in case a pipe splits it.
    if (ask.length < 2 || ask.length < 2 + (ask[1] ?? 0)) {
      held = bytes.subarray(found);
      continue;
    }

    const servername = new TextDecoder().decode(ask.subarray(2, 2 + (ask[1] ?? 0))) || hostname;
    const after = ask.subarray(2 + (ask[1] ?? 0));

    at.upgrading = true;

    if (ask[0] !== ASK_TLS || at.reading) {
      const refusal = ask[0] !== ASK_TLS
        ? 'the egress was asked for something it does not make'
        : 'Kinu\'s egress makes STARTTLS right after a PostgreSQL, MySQL or text-protocol (SMTP, IMAP, POP3, FTP) go-ahead; '
          + 'this connection\'s server was being read when TLS was asked for';

      await toProgram.write(answer(key, refusal));
      await Promise.allSettled([program.close(), server.close()]);

      return;
    }

    at.gate?.open();
    await down;
    fromServer.releaseLock();
    toServer.releaseLock();
    // A server named other than its host is checked by that name (workerd's own node:tls does the same).
    const secure = servername === hostname ? server.startTls() : server.startTls({ expectedServerHostname: servername });

    try {
      await secure.opened;
    } catch (error) {
      await toProgram.write(answer(key, `the TLS session with ${servername} could not be made: ${String(error)}`));
      await Promise.allSettled([program.close(), secure.close()]);

      return;
    }

    await toProgram.write(answer(key, null));
    toProgram.releaseLock();
    fromProgram.releaseLock();

    if (after.length > 0) {
      const writer = secure.writable.getWriter();

      await writer.write(after);
      writer.releaseLock();
    }

    await Promise.all([program.readable.pipeTo(secure.writable, { preventClose: true }), secure.readable.pipeTo(program.writable)]);

    return;
  }
}
