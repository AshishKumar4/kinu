import { asFetchFunction } from './fetch-shim';

/** End an SSE stream at its `data: [DONE]` message (producers may never close after it), forwarding original bytes.
 *  `read` is bytes already taken from `body`. The watcher must be the body's only reader: it cancels between its own
 *  reads, and a workerd body rejects a read that is pending at cancel ("Stream was cancelled.") where a spec stream
 *  resolves it as done. */
export function watchSseTerminal(body: ReadableStream<Uint8Array>, read?: Uint8Array): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = read === undefined ? [] : [read];
  let buffered = read?.length ?? 0;
  let data: string[] = [];
  // Separate flags: the lock must be released on every terminal path, even after settling.
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

      data.push(payload.startsWith(' ') ? payload.slice(1) : payload);
    }

    return false;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (settled) return;

      let newline = indexOfNewline();

      while (newline < 0) {
        let next: Awaited<ReturnType<typeof reader.read>>;

        try {
          next = await reader.read();
        } catch (cause) {
          // Release the lock before propagating the read failure.
          settled = true;
          release();

          throw cause;
        }

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

/** Apply the SSE terminal rule to event-stream responses only; JSON passes through. */
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
