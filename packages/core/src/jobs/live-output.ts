import type { Clock } from '../types/clock';
import type { OutputChunk, OutputSink, OutputStreamName } from '../types/primitives';
import { Effect } from 'effect';
import * as v from 'valibot';
import { diagnostics, settleSync, toKinuError } from '../obs/index';

export const JOB_OUTPUT_EVENT = 'job_output';

const OutputChunkSchema = v.object({ stream: v.picklist(['stdout', 'stderr']), text: v.string() });

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

function appendDroppingOldest(chunks: OutputChunk[], chunk: OutputChunk, cap: number): number {
  const last = chunks.at(-1);

  if (last?.stream === chunk.stream) chunks[chunks.length - 1] = { stream: chunk.stream, text: last.text + chunk.text };
  else chunks.push(chunk);
  let over = chunks.reduce((sum, { text }) => sum + text.length, 0) - cap;
  const dropped = Math.max(over, 0);

  while (over > 0) {
    const first = chunks[0];

    if (first === undefined) break;

    if (first.text.length <= over) {
      chunks.shift();
      over -= first.text.length;
    } else {
      chunks[0] = { stream: first.stream, text: first.text.slice(over) };
      over = 0;
    }
  }

  return dropped;
}

export function followJobOutput(tail: JobOutputTail | undefined, frame: JobOutputFrame): JobOutputTail {
  if (tail !== undefined && frame.seq <= tail.seq) return tail;
  const chunks = [...tail?.chunks ?? []];
  let omitted = (tail?.omitted ?? 0) + frame.dropped;

  for (const chunk of frame.chunks) omitted += appendDroppingOldest(chunks, chunk, TAIL_CHARS);

  return { seq: frame.seq, chunks, omitted };
}

/** Gathers from the call's start; sends once a job takes it. */
class JobOutputFeed implements OutputSink {
  private readonly decoders: Readonly<Record<OutputStreamName, TextDecoder>> = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  private window: OutputChunk[] = [];
  private dropped = 0;
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

  lost(count: number): void {
    if (this.ended) return;
    this.dropped += count;
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
    this.dropped += appendDroppingOldest(this.window, { stream, text }, WINDOW_CHARS);

    if (this.sending && this.disarm === null) this.disarm = this.deps.clock.after(FLUSH_MS, () => { this.flush(); });
  }

  flush(): void {
    this.disarm?.();
    this.disarm = null;

    if (this.window.length === 0) return;
    const frame: JobOutputFrame = { type: JOB_OUTPUT_EVENT, jobId: this.jobId, seq: this.told.seq + 1, chunks: this.window, dropped: this.dropped };
    this.window = [];
    this.dropped = 0;
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
