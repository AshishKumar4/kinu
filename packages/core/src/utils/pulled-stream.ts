/**
 * A stream's chunks, each passed through `step` as its reader pulls it: what `step` returns goes on, and undefined drops
 * the chunk. A pulled stage where a TransformStream would carry every part of a model call: in workerd a TransformStream
 * allocates about 1.8 KB natively for each chunk it carries, and a pulled stage about 30 bytes (a Durable Object reading
 * 2,000 chunks through 1 to 10 stages under V8's sampling heap profiler, 2026-10-19).
 */
export function pulledThrough<I, O>(source: ReadableStream<I>, step: (chunk: I) => O | undefined): ReadableStream<O> {
  const reader = source.getReader();

  return new ReadableStream<O>({
    pull: async (controller) => {
      for (;;) {
        const next = await reader.read();

        if (next.done) {
          controller.close();

          return;
        }

        const passed = step(next.value);

        if (passed !== undefined) {
          controller.enqueue(passed);

          return;
        }
      }
    },
    cancel: async (reason) => { await reader.cancel(reason); },
  }, { highWaterMark: 0 });
}
