/** An OpenAI-compatible stream ends at `data: [DONE]` with the upstream cancelled (`patches/@ai-sdk%2Fprovider-utils@5.0.53.patch`). */
import { describe, test, expect } from 'bun:test';
import { streamText } from 'ai';
import { asFetchFunction } from '../src/providers/fetch-shim';
import { createOpenAICompatProvider, type ModelCallDeps } from '../src/index';

const encoder = new TextEncoder();

function sseData(payload: string): string {
  return `data: ${payload}\n\n`;
}

function delta(content: string): string {
  return sseData(JSON.stringify({ choices: [{ index: 0, delta: { content } }] }));
}

const FINISH = sseData('{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}');

interface Scripted {
  cancels: number;
  stream: ReadableStream<Uint8Array>;
  enqueue: (text: string) => void;
  close: () => void;
}

/** An upstream the test owns: scripted bytes, then the case's lifecycle, with cancels counted. */
function scripted(): Scripted {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const upstream: Scripted = {
    cancels: 0,
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        upstream.cancels += 1;
      },
    }),
    enqueue: (text) => {
      controller?.enqueue(encoder.encode(text));
    },
    close: () => {
      controller?.close();
    },
  };

  return upstream;
}

/** The provider production builds for a named endpoint, answered by the scripted upstream. */
async function streamed(upstream: Scripted): Promise<{ text: string; finishReason: string }> {
  const deps: ModelCallDeps = {
    env: {},
    sessionAffinity: 'kinu-test',
    fetch: asFetchFunction(async () => new Response(upstream.stream, { headers: { 'content-type': 'text/event-stream' } })),
    getAuth: async () => ({ headers: { Authorization: 'Bearer probe-fixture-key' }, baseURL: 'http://fake.invalid/v1' }),
    hasCredential: async () => true,
  };

  const result = streamText({ model: createOpenAICompatProvider().createModel('probe', deps), prompt: 'hello', maxRetries: 0 });

  return { text: await result.text, finishReason: await result.finishReason };
}

describe('an OpenAI-compatible stream at [DONE]', () => {
  test('ends there and cancels a producer that holds the connection open', async () => {
    const upstream = scripted();

    upstream.enqueue(delta('hello'));
    upstream.enqueue(FINISH);
    upstream.enqueue(sseData('[DONE]'));

    expect(await streamed(upstream)).toEqual({ text: 'hello', finishReason: 'stop' });
    expect(upstream.cancels).toBe(1);
  });

  test('detects a terminator split across chunks', async () => {
    const upstream = scripted();

    upstream.enqueue(delta('hi'));
    upstream.enqueue('data: [DO');
    upstream.enqueue('NE]\n\n');

    expect((await streamed(upstream)).text).toBe('hi');
    expect(upstream.cancels).toBe(1);
  });

  test('a CRLF-framed terminator split across chunk boundaries still terminates', async () => {
    const upstream = scripted();

    upstream.enqueue('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\r\n\r\ndata: [DO');
    upstream.enqueue('NE]\r');
    upstream.enqueue('\n\r\n');

    expect((await streamed(upstream)).text).toBe('hi');
    expect(upstream.cancels).toBe(1);
  });

  test('content that contains the marker inside a larger message passes through', async () => {
    const upstream = scripted();

    upstream.enqueue(delta('say [DONE] when ready'));
    upstream.enqueue(FINISH);
    upstream.close();

    expect((await streamed(upstream)).text).toBe('say [DONE] when ready');
    expect(upstream.cancels).toBe(0);
  });

  test('upstream close without a terminator closes cleanly', async () => {
    const upstream = scripted();

    upstream.enqueue(delta('hi'));
    upstream.close();

    expect((await streamed(upstream)).text).toBe('hi');
    expect(upstream.cancels).toBe(0);
  });
});
