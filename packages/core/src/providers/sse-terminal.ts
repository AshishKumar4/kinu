import { asFetchFunction } from './fetch-shim';

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
 * with the lock released; downstream cancel propagates to the upstream
 * reader, preserving backpressure and abort semantics. A cancel rejection
 * still releases the lock before propagating — turning it into success
 * would hide a broken pipe behind a clean close.
 */
function watchSseTerminal(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
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

  const release = (): void => {
    if (released) return;

    released = true;
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

      data.push(payload.startsWith(' ') ? payload.slice(1) : payload);
    }

    return false;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (settled) return;

      let newline = indexOfNewline();

      while (newline < 0) {
        const next = await reader.read();

        if (settled) return;

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
        // pull's throw and the broken pipe reads as success.
        try {
          await cancelUpstream();
        } catch (cause) {
          controller.error(cause);

          return;
        }

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
 * `data: [DONE]` with the upstream reader cancelled, everything else passes
 * through untouched. The content-type gate is what keeps JSON answers (and
 * non-SSE providers sharing a fetch chain) out of the watcher.
 */
export function withSseTerminal(fetchImpl: typeof fetch): typeof fetch {
  return asFetchFunction(async (input, init) => {
    const response = await fetchImpl(input, init);
    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('text/event-stream') || !response.body) return response;

    return new Response(watchSseTerminal(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });
}
