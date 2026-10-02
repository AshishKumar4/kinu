import type { Clock } from '../types/clock';
import type { OutputChunk, OutputSink, OutputStreamName } from '../types/primitives';
import { Effect } from 'effect';
import * as v from 'valibot';
import { diagnostics, settleSync, toKinuError } from '../obs/index';
import { formatBytes } from '../utils/format';

export const JOB_OUTPUT_EVENT = 'job_output';

const OutputChunkSchema = v.object({ stream: v.picklist(['stdout', 'stderr']), text: v.string(), omitted: v.optional(v.number()) });

export interface JobOutputFrame {
  readonly type: typeof JOB_OUTPUT_EVENT;
  readonly jobId: string;
  readonly seq: number;
  readonly chunks: readonly OutputChunk[];
  readonly dropped: number;
}

export interface JobOutputTail {
  readonly seq: number;
  readonly chunks: readonly OutputChunk[];
  readonly omitted: number;
}

export const JobOutputFrameSchema = v.object({
  type: v.literal(JOB_OUTPUT_EVENT), jobId: v.string(), seq: v.number(), chunks: v.array(OutputChunkSchema), dropped: v.number(),
}) satisfies v.GenericSchema<unknown, JobOutputFrame>;

export const JobOutputTailSchema = v.object({
  seq: v.number(), chunks: v.array(OutputChunkSchema), omitted: v.number(),
}) satisfies v.GenericSchema<unknown, JobOutputTail>;

const FLUSH_MS = 250;

const WINDOW_CHARS = 16_384;

const TAIL_CHARS = 16_384;

const encoder = new TextEncoder();

function withOmitted(chunk: OutputChunk, omitted: number): OutputChunk {
  return omitted > 0 ? { stream: chunk.stream, text: chunk.text, omitted } : { stream: chunk.stream, text: chunk.text };
}

function omittedIn(chunks: readonly OutputChunk[]): number {
  return chunks.reduce((sum, { omitted = 0 }) => sum + omitted, 0);
}

function keepNewest(chunks: OutputChunk[], chunk: OutputChunk, cap: number): void {
  const last = chunks.at(-1);

  if (last !== undefined && last.text === '') chunks[chunks.length - 1] = withOmitted(chunk, omittedIn([last, chunk]));
  else if (last?.stream === chunk.stream && chunk.omitted === undefined) chunks[chunks.length - 1] = withOmitted({ stream: last.stream, text: last.text + chunk.text }, last.omitted ?? 0);
  else chunks.push(chunk);
  let over = chunks.reduce((sum, { text }) => sum + text.length, 0) - cap;
  let shed = 0;

  while (over > 0) {
    const first = chunks[0];

    if (first === undefined) break;

    if (first.text.length <= over) {
      chunks.shift();
      shed += (first.omitted ?? 0) + encoder.encode(first.text).byteLength;
      over -= first.text.length;
    } else {
      chunks[0] = withOmitted({ stream: first.stream, text: first.text.slice(over) }, (first.omitted ?? 0) + encoder.encode(first.text.slice(0, over)).byteLength);
      over = 0;
    }
  }

  const head = chunks[0];

  if (head !== undefined && shed > 0) chunks[0] = withOmitted(head, (head.omitted ?? 0) + shed);
}

export function followJobOutput(tail: JobOutputTail | undefined, frame: JobOutputFrame): JobOutputTail {
  if (tail !== undefined && frame.seq <= tail.seq) return tail;
  const chunks = [...tail?.chunks ?? []];
  // A sender that places no loss counts it only, before its first chunk.
  const unplaced = frame.dropped - omittedIn(frame.chunks);

  for (const [at, chunk] of frame.chunks.entries()) {
    keepNewest(chunks, at === 0 ? withOmitted(chunk, (chunk.omitted ?? 0) + unplaced) : chunk, TAIL_CHARS);
  }

  return { seq: frame.seq, chunks, omitted: omittedIn(chunks) };
}

function omittedMarker(bytes: number): string {
  return `... ${formatBytes(bytes)} omitted ...`;
}

type OutputLine = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'lost'; readonly bytes: number };

/** The last `count` lines; a loss among them marked in place, every one before them above them. */
export function lastOutputLines(tail: JobOutputTail | undefined, count: number): string[] {
  const items: OutputLine[] = [];
  let line = '';

  for (const { text, omitted = 0 } of tail?.chunks ?? []) {
    if (omitted > 0) {
      if (line !== '') items.push({ kind: 'text', text: line });
      const previous = items.at(-1);

      if (previous?.kind === 'lost') items[items.length - 1] = { kind: 'lost', bytes: previous.bytes + omitted };
      else items.push({ kind: 'lost', bytes: omitted });
      line = '';
    }

    const [first = '', ...rest] = text.split('\n');
    line += first;

    for (const next of rest) {
      items.push({ kind: 'text', text: line });
      line = next;
    }
  }

  if (line !== '') items.push({ kind: 'text', text: line });
  const lines = items.flatMap((item, at) => (item.kind === 'text' ? [at] : []));
  const start = lines.at(-count) ?? lines[0] ?? items.length;
  const before = items.slice(0, start).reduce((sum, item) => sum + (item.kind === 'lost' ? item.bytes : 0), 0);
  const shown = items.slice(start).map((item) => (item.kind === 'lost' ? omittedMarker(item.bytes) : item.text));

  return before > 0 ? [omittedMarker(before), ...shown] : shown;
}

/** Gathers from the call's start; sends once a job takes it. */
class JobOutputFeed implements OutputSink {
  private readonly decoders: Readonly<Record<OutputStreamName, TextDecoder>> = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  private window: OutputChunk[] = [];
  private lostAfterWindow = 0;
  private told: JobOutputTail = { seq: 0, chunks: [], omitted: 0 };
  private sending = false;
  private ended = false;
  private disarm: (() => void) | null = null;

  constructor(
    private readonly jobId: string,
    private readonly deps: { readonly clock: Clock; readonly send: (frame: JobOutputFrame) => void; readonly closed: () => void },
  ) {}

  write(stream: OutputStreamName, data: Uint8Array | string): void {
    if (this.ended) return;
    this.gather(stream, data instanceof Uint8Array ? this.decoders[stream].decode(data, { stream: true }) : data);
  }

  lost(bytes: number): void {
    if (this.ended) return;
    this.lostAfterWindow += bytes;
    this.arm();
  }

  live(): void {
    if (this.sending || this.ended) return;
    this.sending = true;
    this.flush();
  }

  end(): void {
    if (this.ended) return;

    this.gather('stdout', this.decoders.stdout.decode());
    this.gather('stderr', this.decoders.stderr.decode());

    if (this.sending) this.flush();
    this.ended = true;
    this.disarm?.();
    this.deps.closed();
  }

  tail(): JobOutputTail {
    return this.told;
  }

  private gather(stream: OutputStreamName, text: string): void {
    if (text === '') return;
    keepNewest(this.window, withOmitted({ stream, text }, this.lostAfterWindow), WINDOW_CHARS);
    this.lostAfterWindow = 0;
    this.arm();
  }

  private arm(): void {
    if (this.sending && this.disarm === null) this.disarm = this.deps.clock.after(FLUSH_MS, () => { this.flush(); });
  }

  flush(): void {
    this.disarm?.();
    this.disarm = null;

    if (this.lostAfterWindow > 0) {
      keepNewest(this.window, { stream: this.window.at(-1)?.stream ?? 'stdout', text: '', omitted: this.lostAfterWindow }, WINDOW_CHARS);
      this.lostAfterWindow = 0;
    }

    if (this.window.length === 0) return;
    const frame: JobOutputFrame = { type: JOB_OUTPUT_EVENT, jobId: this.jobId, seq: this.told.seq + 1, chunks: this.window, dropped: omittedIn(this.window) };
    this.window = [];
    this.told = followJobOutput(this.told, frame);

    return settleSync(this.sent(frame));
  }

  private sent(frame: JobOutputFrame): Effect.Effect<void> {
    return Effect.try({
      try: () => { this.deps.send(frame); },
      catch: (cause) => toKinuError({ doing: "send a running job's output to its rooms", cause, otherwise: 'io' }),
    }).pipe(Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('jobs.output_unsent', failure, { jobId: this.jobId }); })));
  }
}

export class JobOutputFeeds {
  private readonly feeds = new Map<string, JobOutputFeed>();

  constructor(private readonly deps: { readonly clock: Clock; readonly send: (frame: JobOutputFrame) => void }) {}

  open(jobId: string): JobOutputFeed {
    const feed = new JobOutputFeed(jobId, { ...this.deps, closed: () => { this.feeds.delete(jobId); } });
    this.feeds.set(jobId, feed);

    return feed;
  }

  tail(jobId: string): JobOutputTail | undefined {
    return this.feeds.get(jobId)?.tail();
  }
}
