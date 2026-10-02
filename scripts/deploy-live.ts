/**
 * THE DEPLOY'S LIVE STATUS. While a deploy phase runs its rows, `live.txt` in the deploy's report directory says which
 * rows run, for how long, and the last line each printed, so whoever watches or cancels a long deploy knows what it
 * waits on. Nothing else says it while it waits: in a wave each row's output is piped and printed whole when the row
 * ends (ladder.ts), and report.md is rendered at the deploy's end. The eval pass prints `waiting on job <id> (<what it
 * runs>) since <its start>` once a minute for a trial a job holds, so its line names the trial and the job.
 *
 * Rewritten when a row starts or ends, and otherwise at most once a second while output arrives: a busy suite prints
 * thousands of lines a second. Each rewrite replaces the file whole, so a reader never sees half of one.
 */
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REAL_CLOCK, type Clock } from '../packages/core/src/types/clock';
import type { RunStatus } from './deadline';

/** The live status's file in a deploy's report directory. */
export const LIVE_FILE = 'live.txt';

/** The shortest time between two rewrites for output alone. */
const REWRITE_MS = 1_000;

/** How much of a line the file keeps: a row's last line, or a line still arriving. */
const LINE_CHARS = 400;

/** A terminal's colour and cursor sequences, which a file shows as noise. */
const ESCAPES = new RegExp(`${String.fromCodePoint(0x1B)}\\[[0-9;?]*[A-Za-z]`, 'gu');

/** One running row: when it started, the last whole line it printed, and what it has printed of the next. */
type Row = { readonly label: string; readonly startedAt: number; last: string; readonly partial: Record<'stdout' | 'stderr', string> };

/** `ms` as a reader of a long run wants it: `41m12s`, `1h02m`, `9s`. */
function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);

  if (seconds < 60) return `${String(seconds)}s`;

  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m${String(seconds % 60).padStart(2, '0')}s`;

  return `${String(Math.floor(seconds / 3600))}h${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`;
}

/** What a terminal would show of `line`: no escape sequences, and what follows its last carriage return. */
function shown(line: string): string {
  return line.replace(ESCAPES, '').split('\r').at(-1)?.trim().slice(0, LINE_CHARS) ?? '';
}

export class DeployLive {
  private readonly rows = new Set<Row>();

  private writtenAt = Number.NEGATIVE_INFINITY;

  private disarm: (() => void) | null = null;

  private closed = false;

  constructor(private readonly dir: string, private readonly phase: string, private readonly clock: Clock = REAL_CLOCK) {}

  /** A row starts, and the file says so at once. Its runner tells the rest (`runUnderDeadline`'s `status`). */
  started(label: string): RunStatus {
    const row: Row = { label, startedAt: this.clock.now(), last: '', partial: { stdout: '', stderr: '' } };

    this.rows.add(row);
    this.write();

    return {
      output: (text, from) => {
        const lines = (row.partial[from] + text).split('\n');

        row.partial[from] = (lines.pop() ?? '').slice(-LINE_CHARS);
        const last = lines.map(shown).filter((line) => line !== '').at(-1);

        if (last === undefined) return;
        row.last = last;
        this.soon();
      },
      ended: () => {
        this.rows.delete(row);
        this.write();
      },
    };
  }

  /** The phase's runner is ending: the file says so, with the rows still running then, and is written no more. */
  close(): void {
    this.write(true);
    this.closed = true;
  }

  private soon(): void {
    if (this.disarm !== null || this.closed) return;
    this.disarm = this.clock.after(Math.max(0, this.writtenAt + REWRITE_MS - this.clock.now()), () => {
      this.disarm = null;
      this.write();
    });
  }

  private write(ending = false): void {
    if (this.closed) return;
    this.disarm?.();
    this.disarm = null;

    const now = this.clock.now();
    const at = new Date(now).toISOString();
    const running = [...this.rows];

    const head = ending
      ? `deploy phase ${this.phase} ended at ${at}${running.length === 0 ? '' : ` with ${String(running.length)} row(s) still running:`}`
      : `deploy phase ${this.phase} at ${at}: ${running.length === 0 ? 'nothing running' : `${String(running.length)} row(s) running`}`;

    const lines = running.map((row) => `${row.label}, ${elapsed(now - row.startedAt)}: ${row.last === '' ? '(nothing printed yet)' : row.last}`);
    const file = join(this.dir, LIVE_FILE);

    writeFileSync(`${file}.part`, `${[head, ...lines].join('\n')}\n`);
    renameSync(`${file}.part`, file);
    this.writtenAt = now;
  }
}

/** The live status of a deploy phase's runner, its last word written when the process exits, whatever ends it: a
 *  cancel exits from scripts/deadline.ts, with no step of the runner's own after it. */
export function openDeployLive(report: string, phase: string): DeployLive {
  const live = new DeployLive(report, phase);

  process.on('exit', () => { live.close(); });

  return live;
}
