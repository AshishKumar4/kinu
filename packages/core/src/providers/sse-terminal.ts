import { asFetchFunction } from './fetch-shim';
import { REAL_CLOCK, type Clock } from '../types/clock';
import { KinuError } from '../obs/index';

/**
 * How long a model stream may hold a read open while sending no content
 * before the pipe is read as broken.
 *
 * THIS IS NOT A DEADLINE ON WORK. Work here ends on completion, definitive
 * failure, or cancellation, never on elapsed time, and this bound keeps that
 * rule rather than carving an exception out of it. What is measured is only
 * the stretch in which a read is outstanding and the producer has sent no
 * content frame, and every content frame restarts it: a model that streams
 * for six hours is never cut, however slowly it produces, because each frame
 * is fresh evidence that the far side is alive. What expires is the EVIDENCE,
 * not the work. A socket with nothing behind it is a definitive failure, and
 * the only alternative to naming it is a turn parked until a human presses
 * Stop — which is what this stream layer did until now.
 *
 * TEN MINUTES, and the basis. The longest legitimate silence inside one of
 * these streams is a reasoning model's thinking phase on the OpenAI dialect,
 * where reasoning is not streamed and the first content frame arrives only
 * once it is over. That phase's ceiling is UNMEASURED here. What this tree
 * has recorded is the shorter number either side of it: a whole streamed step
 * is silent for "tens of seconds" (heads/head-inference.ts, heads/head-stream.ts),
 * and five minutes is already treated as an ordinary gap BETWEEN requests
 * (providers/cache-warming.ts, Anthropic's short cache entry). Ten minutes is
 * an order of magnitude past the longest silence measured inside a stream and
 * twice the longest gap treated as ordinary outside one. Measured instead is
 * the discrimination the number rests on, in unit-sse-terminal.test.ts:
 * keepalive framing does not restart it and content does.
 */
const SSE_CONTENT_IDLE_MS = 10 * 60_000;

/** The race's non-read arm. A symbol rather than a flag so the read result and
 *  the stall cannot be confused by a producer sending a value that looks like
 *  one. */
const STALLED: unique symbol = Symbol('sse-terminal: no content');

/**
 * End an SSE stream at its `data: [DONE]` terminator instead of at producer
 * close.
 *
 * A consumer that stops at [DONE] — every OpenAI-dialect client — leaves the
 * upstream body open when the producer never closes behind the terminator:
 * the turn hangs awaiting stream end, and the unreleased pipe is killed as
 * hung later. Watching here, at the fetch boundary every compat provider
 * funnels through, applies the rule once for all of them: forward bytes
 * until a complete SSE message whose data is exactly `[DONE]`, then cancel
 * the upstream reader and close.
 *
 * Framing is real, on bytes, with no spread of network chunks into argument
 * lists (a large frame would blow the call stack — bytes move in a chunk
 * queue and are sliced at frame boundaries by copy). Messages end at blank
 * lines; a `\r` immediately before the newline is framing, never data, so
 * CRLF streams terminate while content merely containing the marker inside
 * a larger message does not. Forwarded bytes are the originals, never
 * re-encoded, so the downstream parser sees bit-for-bit what the producer
 * sent; bytes past the terminal message are swallowed — the stream is over
 * and nothing is owed them.
 *
 * Non-SSE responses never enter: callers gate on the event-stream
 * content-type, so JSON bodies that happen to contain the marker pass
 * through untouched. Upstream close without a terminator closes cleanly
 * with the lock released — the dialect's terminator is not universal among
 * the gateways that speak it, so the absence of one is named a turn later,
 * where the provider's own finish reason is in hand (orchestrator/turn-lifecycle.ts,
 * PROVIDER_NAMED_NO_END); downstream cancel propagates to the upstream
 * reader, preserving backpressure and abort semantics. A cancel rejection
 * still releases the lock before propagating — turning it into success
 * would hide a broken pipe behind a clean close.
 *
 * A producer that sends NOTHING is the case none of the above reaches: no
 * terminator, no close, no error, just a held socket. {@link SSE_CONTENT_IDLE_MS}
 * bounds it, keyed on content rather than on bytes — `messageLine` already
 * separates a `data:` payload from framing, and only a payload with length
 * restarts the window, so the comment lines and empty data frames every
 * gateway sends as keepalives buy no time. The window is armed only while a
 * read is outstanding and is measured from the last content frame, so a
 * consumer that pauses does not spend it and a producer that pauses does.
 */
function watchSseTerminal(body: ReadableStream<Uint8Array>, clock: Clock): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let buffered = 0;
  let data: string[] = [];
  // `settled` marks terminal state reached, so at most one terminal action
  // runs; `released` marks the reader lock released. They are separate
  // because the lock must be released on EVERY terminal path — including a
  // downstream cancel that already marked settled, and a cancel rejection,
  // which still releases before propagating.
  let settled = false;
  let released = false;
  // When the producer last sent a data line carrying a payload, and the timer
  // watching for the next one. The stream's start counts as content: a body
  // that never sends a first frame is the same silence as one that stops.
  let lastContentAt = clock.now();
  let disarm: () => void = () => {};

  const stall = Promise.withResolvers<typeof STALLED>();

  const armStall = (): void => {
    disarm();
    disarm = clock.after(lastContentAt + SSE_CONTENT_IDLE_MS - clock.now(), () => { stall.resolve(STALLED); });
  };

  const release = (): void => {
    if (released) return;

    released = true;
    disarm();
    reader.releaseLock();
  };

  const cancelUpstream = async (): Promise<void> => {
    if (settled) return;

    settled = true;

    try {
      await reader.cancel();
    } finally {
      release();
    }
  };

  const takeBytes = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let at = 0;

    while (at < n) {
      const head = chunks.shift();

      if (head === undefined) throw new Error('sse-terminal: takeBytes past buffered end');

      const want = Math.min(head.length, n - at);

      out.set(head.subarray(0, want), at);
      at += want;

      if (want < head.length) chunks.unshift(head.subarray(want));
    }

    buffered -= n;

    return out;
  };

  const indexOfNewline = (): number => {
    let at = 0;

    for (const chunk of chunks) {
      const found = chunk.indexOf(0x0a);

      if (found >= 0) return at + found;

      at += chunk.length;
    }

    return -1;
  };

  // One complete line (without its newline) processed into the current
  // message. Returns true when the line completed the terminal message.
  const messageLine = (line: Uint8Array): boolean => {
    const framed = line.length > 0 && line[line.length - 1] === 0x0d
      ? line.subarray(0, -1)
      : line;

    if (framed.length === 0) {
      const joined = data.join('\n');

      data = [];

      return joined === '[DONE]';
    }

    const text = decoder.decode(framed);

    if (text.startsWith('data:')) {
      const payload = text.slice('data:'.length);
      const value = payload.startsWith(' ') ? payload.slice(1) : payload;

      if (value.length > 0) lastContentAt = clock.now();

      data.push(value);
    }

    return false;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (settled) return;

      let newline = indexOfNewline();

      while (newline < 0) {
        armStall();

        // The union the DOM lib's `read()` answers differs from the workers
        // types' only in the done-arm's optional `value`, so this is a
        // handled read: on failure the lock releases and the same cause
        // rethrows, never widening what the consumer sees.
        let next: Awaited<ReturnType<typeof reader.read>> | typeof STALLED;

        try {
          next = await Promise.race([reader.read(), stall.promise]);
        } catch (cause) {
          // A failed upstream read propagates, but not before the lock is
          // released — the body this reader holds must not stay locked
          // behind an error the consumer will never drain.
          settled = true;
          release();

          throw cause;
        }

        disarm();

        if (settled) return;

        if (next === STALLED) {
          // Cancel before throwing, for the reason the terminator arm gives:
          // the consumer's error path is the only place this can be acted on,
          // and it must not find the upstream still held. The instant is
          // carried because it is the one fact a reader of the run cannot
          // recover — how long the socket was open with nothing behind it.
          await cancelUpstream();

          throw new KinuError('timeout', 'the model stream sent no content for '
            + `${clock.now() - lastContentAt} ms; the last content frame arrived at `
            + `${new Date(lastContentAt).toISOString()}`);
        }

        if (next.done) {
          if (buffered > 0) controller.enqueue(takeBytes(buffered));

          controller.close();
          settled = true;
          release();

          return;
        }

        chunks.push(next.value);
        buffered += next.value.length;
        newline = indexOfNewline();
      }

      const raw = takeBytes(newline + 1);
      const terminal = messageLine(raw.subarray(0, newline));

      controller.enqueue(raw);

      if (terminal) {
        // Cancel first: a rejection must reach the consumer's error path,
        // which closing first would mask — a closed stream swallows the
        // pull's throw and the broken pipe reads as success. Letting it
        // throw out of `pull` errors the stream with that cause, which is
        // what `controller.error` did by hand.
        await cancelUpstream();
        controller.close();
      }
    },
    async cancel(reason) {
      if (settled) return;

      settled = true;

      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

/**
 * The fetch-level application of the terminal rule: streamed answers end at
 * `data: [DONE]` with the upstream reader cancelled, at a producer that has
 * gone quiet past {@link SSE_CONTENT_IDLE_MS}, and everything else passes
 * through untouched. The content-type gate is what keeps JSON answers (and
 * non-SSE providers sharing a fetch chain) out of the watcher. The clock is a
 * parameter because the quiet window is time inside a subject: production
 * hands the real one, a suite hands a clock it advances.
 */
export function withSseTerminal(fetchImpl: typeof fetch, clock: Clock = REAL_CLOCK): typeof fetch {
  return asFetchFunction(async (input, init) => {
    const response = await fetchImpl(input, init);
    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('text/event-stream') || !response.body) return response;

    return new Response(watchSseTerminal(response.body, clock), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });
}
