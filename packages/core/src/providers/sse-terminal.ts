import { asFetchFunction } from './fetch-shim';
import { REAL_CLOCK, type Clock } from '../types/clock';
import { KinuError } from '../obs/index';

/** Content-idle bound on an outstanding read, not a deadline on work: every content
 *  frame restarts it, keepalives do not. The longest legitimate silence is unmeasured. */
const SSE_CONTENT_IDLE_MS = 10 * 60_000;

/** A symbol so no producer value can be mistaken for the stall. */
const STALLED: unique symbol = Symbol('sse-terminal: no content');

/** End an SSE stream at its `data: [DONE]` message (producers may never close after it),
 *  forwarding original bytes; a silent producer is bounded by {@link SSE_CONTENT_IDLE_MS}. */
function watchSseTerminal(body: ReadableStream<Uint8Array>, clock: Clock): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let buffered = 0;
  let data: string[] = [];
  // Separate flags: the lock must be released on every terminal path, even after settling.
  let settled = false;
  let released = false;
  // The stream's start counts as content, so a body that never sends is the same silence.
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

  // True when the line completed the terminal message.
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

        let next: Awaited<ReturnType<typeof reader.read>> | typeof STALLED;

        try {
          next = await Promise.race([reader.read(), stall.promise]);
        } catch (cause) {
          // Release the lock before propagating the read failure.
          settled = true;
          release();

          throw cause;
        }

        disarm();

        if (settled) return;

        if (next === STALLED) {
          // Cancel upstream before throwing; the idle duration is otherwise unrecoverable.
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
        // Cancel before close: a closed stream swallows the rejection as success.
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

/** Apply the SSE terminal rule to event-stream responses only; JSON passes through.
 *  The clock is injectable for tests. */
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
