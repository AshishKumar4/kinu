/**
 * A workspace program's TLS socket, made by Kinu's egress (Kinu's Nimbus patch, NIMBUS-ASKS #37). workerd carries no TLS
 * over an entrypoint's connect ("Incoming CONNECT with TLS not supported"), so the program's node:tls opens a plaintext
 * carrier to `tls.nimbus-egress.invalid:<port>` and, as its session starts, writes `'T' <n:2> <host> <n:2> <servername>`
 * (UTF-8). The egress judges the host, makes the TLS session with the server, and answers `1` once it is made or
 * `0 <n:2> <reason>` (the refusal or the handshake's failure) before closing; only then does the program's session open,
 * so a certificate the server fails reaches the program as its connection's error. The plaintext is carried after.
 */

import { Cause, Effect } from 'effect';
import { diagnostics, renderThrownChain, settle, toKinuError } from '@kinu.run/core/obs';

/** The name every TLS carrier connects to: fixed, so a long host never meets workerd's address limit. */
export const TLS_CARRIER_HOST = 'tls.nimbus-egress.invalid';

const ASK_TLS = 0x54;

/** Longer names than any host or servername; a request past it is refused unread. */
const MAX_NAME_BYTES = 1024;

/** The two ends this carries between; workerd's `Socket` is one. */
export interface CarriedSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

/** The server's end: a connection made with `secureTransport: 'starttls'`. */
export interface StartableSocket extends CarriedSocket {
  startTls(options?: { readonly expectedServerHostname?: string }): CarriedSocket & { readonly opened: Promise<unknown> };
}

export interface TlsCarrierDeps {
  /** The port the carrier named. */
  readonly port: number;
  /** Why `hostname` may not be reached, or null. */
  refused(hostname: string): string | null;
  /** A plaintext connection to the server that can start TLS. */
  connect(target: { readonly hostname: string; readonly port: number }): StartableSocket;
}

interface TlsRequest {
  readonly host: string;
  readonly servername: string;
  /** Bytes the program sent after its request (none in practice: it waits for the answer). */
  readonly after: Uint8Array;
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length);

  joined.set(first);
  joined.set(second, first.length);

  return joined;
}

/** The request the program writes first, or why it is not one; read to its end and no further. */
async function readRequest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<TlsRequest | string> {
  let held: Uint8Array = new Uint8Array(0);

  const need = async (length: number): Promise<boolean> => {
    while (held.length < length) {
      const { value, done } = await reader.read();

      if (done) return false;
      held = concat(held, value);
    }

    return true;
  };

  if (!await need(3)) return 'the TLS carrier closed before its request';

  if (held[0] !== ASK_TLS) return 'the TLS carrier sent no TLS request';
  const hostLength = ((held[1] ?? 0) << 8) | (held[2] ?? 0);

  if (hostLength === 0 || hostLength > MAX_NAME_BYTES || !await need(3 + hostLength + 2)) return 'the TLS request names no host';
  const nameLength = ((held[3 + hostLength] ?? 0) << 8) | (held[4 + hostLength] ?? 0);

  if (nameLength > MAX_NAME_BYTES || !await need(5 + hostLength + nameLength)) return 'the TLS request\'s servername is cut short';
  const decoder = new TextDecoder();
  const host = decoder.decode(held.subarray(3, 3 + hostLength));
  const servername = decoder.decode(held.subarray(5 + hostLength, 5 + hostLength + nameLength)) || host;

  return { host, servername, after: held.subarray(5 + hostLength + nameLength) };
}

function refusal(reason: string): Uint8Array {
  const bytes = new TextEncoder().encode(reason).subarray(0, 0xffff);

  return concat(Uint8Array.of(0, bytes.length >> 8, bytes.length & 0xff), bytes);
}

/** Carry one TLS carrier: its request answered, then its plaintext both ways until either end closes. */
export function carryTls(program: CarriedSocket, deps: TlsCarrierDeps): Promise<void> {
  return settle(Effect.gen(function* () {
    const reader = program.readable.getReader();
    const writer = program.writable.getWriter();
    const request = yield* Effect.promise(() => readRequest(reader));
    const reason = typeof request === 'string' ? request : deps.refused(request.host);

    if (typeof request === 'string' || reason !== null) {
      yield* Effect.promise(async () => {
        await writer.write(refusal(reason ?? 'the TLS request was refused'));
        await program.close();
      });

      return;
    }

    const server = deps.connect({ hostname: request.host, port: deps.port });
    // A server named other than its host is checked by that name (workerd's own node:tls does the same).
    const secure = request.servername === request.host ? server.startTls() : server.startTls({ expectedServerHostname: request.servername });

    const failed = yield* Effect.matchCause(Effect.promise(() => secure.opened), {
      onSuccess: () => null,
      onFailure: (cause) => Cause.squash(cause),
    });

    if (failed !== null) {
      diagnostics.failure('egress.tls_failed', toKinuError({ doing: `making the TLS session with ${request.servername}`, cause: failed, otherwise: 'io' }), {
        host: request.host, seam: 'workspace-connect',
      });
      yield* Effect.promise(async () => {
        await writer.write(refusal(`the TLS session with ${request.servername} could not be made: ${renderThrownChain({ cause: failed })}`));
        await Promise.allSettled([program.close(), secure.close()]);
      });

      return;
    }

    yield* Effect.promise(async () => {
      await writer.write(Uint8Array.of(1));
      writer.releaseLock();
      reader.releaseLock();

      if (request.after.length > 0) {
        const early = secure.writable.getWriter();

        await early.write(request.after);
        early.releaseLock();
      }

      // The program's end of input is not passed on: closing a workerd socket's writable ended its readable too, so a
      // client that half-closed after its request got no answer (scripts/egress-probe.ts, 2026-10-10). The server's own
      // close ends the socket.
      await Promise.all([program.readable.pipeTo(secure.writable, { preventClose: true }), secure.readable.pipeTo(program.writable)]);
    });
  }));
}
