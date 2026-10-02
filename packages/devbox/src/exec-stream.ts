import { Effect } from 'effect';
import * as v from 'valibot';
import type { ExecResult } from './contracts';
import { DevboxError, attempt, settle } from './errors';

const STDOUT = 1;

const STDERR = 2;

const EXIT = 3;

const HEADER = 5;

type ExecRecord =
  | { readonly stream: 'stdout' | 'stderr'; readonly data: Uint8Array }
  | { readonly exitCode: number };

function framed(tag: number, payload: Uint8Array): Uint8Array {
  const record = new Uint8Array(HEADER + payload.byteLength);
  const view = new DataView(record.buffer);
  view.setUint8(0, tag);
  view.setUint32(1, payload.byteLength);
  record.set(payload, HEADER);

  return record;
}

function exitPayload(exitCode: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setInt32(0, exitCode);

  return payload;
}

const BytesSchema = v.instance(Uint8Array);

interface PipeReader {
  read(): Promise<{ readonly done: boolean; readonly value?: unknown }>;
  cancel(): Promise<void>;
}

interface Pipe {
  readonly tag: number;
  readonly reader: PipeReader;
  reading: Promise<{ readonly pipe: Pipe; readonly read: { readonly done: boolean; readonly value?: unknown } }> | undefined;
}

export function execRecords(
  process: Pick<ExecProcess, 'stdout' | 'stderr' | 'exitCode'>,
  hooks: { readonly exited: () => void; readonly cancelled: () => Promise<void> },
): ReadableStream<Uint8Array> {
  const pipes: Pipe[] = [];

  if (process.stdout !== null) pipes.push({ tag: STDOUT, reader: process.stdout.getReader(), reading: undefined });

  if (process.stderr !== null) pipes.push({ tag: STDERR, reader: process.stderr.getReader(), reading: undefined });
  let open = pipes;

  const next = (controller: ReadableStreamDefaultController<Uint8Array>) => Effect.gen(function* () {
    while (open.length > 0) {
      for (const pipe of open) pipe.reading ??= pipe.reader.read().then((read) => ({ pipe, read }));
      const { pipe, read } = yield* attempt('process', () => Promise.race(open.flatMap((held) => held.reading ?? [])));
      pipe.reading = undefined;

      if (read.done) {
        open = open.filter((held) => held !== pipe);
        continue;
      }

      controller.enqueue(framed(pipe.tag, v.parse(BytesSchema, read.value)));

      return;
    }

    controller.enqueue(framed(EXIT, exitPayload(yield* attempt('process', () => process.exitCode))));
    hooks.exited();
    controller.close();
  });

  return new ReadableStream<Uint8Array>({
    pull: (controller) => settle(next(controller)),
    cancel: () => settle(Effect.gen(function* () {
      yield* attempt('process', hooks.cancelled);

      for (const pipe of pipes) yield* attempt('process', () => pipe.reader.cancel());
    })),
  });
}

function readExecRecords(stream: ReadableStream<Uint8Array>): ReadableStream<ExecRecord> {
  let held = new Uint8Array(0);

  return stream.pipeThrough(new TransformStream<Uint8Array, ExecRecord>({
    transform(chunk, records) {
      const joined = new Uint8Array(held.byteLength + chunk.byteLength);
      joined.set(held);
      joined.set(chunk, held.byteLength);
      let at = 0;

      while (joined.byteLength - at >= HEADER) {
        const view = new DataView(joined.buffer, joined.byteOffset + at);
        const length = view.getUint32(1);

        if (joined.byteLength - at < HEADER + length) break;
        const payload = joined.slice(at + HEADER, at + HEADER + length);
        const tag = view.getUint8(0);

        if (tag === EXIT) records.enqueue({ exitCode: new DataView(payload.buffer).getInt32(0) });
        else records.enqueue({ stream: tag === STDERR ? 'stderr' : 'stdout', data: payload });
        at += HEADER + length;
      }

      held = joined.slice(at);
    },
  }));
}

export function collectExecRecords(
  stream: ReadableStream<Uint8Array>,
  heard: (stream: 'stdout' | 'stderr', data: Uint8Array) => void,
): Promise<ExecResult> {
  return settle(Effect.gen(function* () {
    const reader = readExecRecords(stream).getReader();
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const text = { stdout: '', stderr: '' };

    for (;;) {
      const read = yield* attempt('process', () => reader.read());

      if (read.done) return yield* Effect.fail(new DevboxError('process', 'the command stream ended without its exit code'));
      const record = read.value;

      if ('exitCode' in record) {
        return { stdout: text.stdout + decoders.stdout.decode(), stderr: text.stderr + decoders.stderr.decode(), exitCode: record.exitCode };
      }

      heard(record.stream, record.data);
      text[record.stream] += decoders[record.stream].decode(record.data, { stream: true });
    }
  }));
}
