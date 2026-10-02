/**
 * Prompt input via blocking canonical-mode reads on the terminal fd; never readline or raw mode: macOS kqueue cannot
 * poll /dev/tty, so under `kinu setup </dev/tty` keys never arrive. No terminal raises NonInteractiveError.
 */
import { Data, Effect } from 'effect';
import { settleSync, settle } from '@kinu.run/core/obs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, readSync } from 'node:fs';
import { ACCENT, DIM } from './display';

class NonInteractiveError extends Data.TaggedError('NonInteractiveError')<{ readonly message: string }> {
  constructor(message = 'This step needs an interactive terminal. Re-run from a terminal, or pass flags to skip prompts.') {
    super({ message });
  }
}

interface TerminalInput {
  fd: number;
  close: () => void;
}

function openTerminal(): TerminalInput | null {
  try {
    const fd = openSync('/dev/tty', 'r');

    return { fd, close: () => closeSync(fd) };
  } catch (error) {
    // ENXIO: no controlling terminal; ENOENT: node missing. Anything else is real.
    if (!(error instanceof Error && 'code' in error && (error.code === 'ENXIO' || error.code === 'ENOENT'))) throw error;

    return process.stdin.isTTY ? { fd: 0, close: () => {} } : null;
  }
}

export function canPrompt(): boolean {
  const tty = openTerminal();

  if (!tty) return false;
  tty.close();

  return true;
}

/** opentui cannot reopen /dev/tty; refuse instead of a frozen screen. */
export function requireInteractiveTerminal(): void {
  return settleSync(Effect.gen(function* () {
    if (process.stdin.isTTY && process.stdout.isTTY) return;

    return yield* Effect.die(new Error('The Kinu TUI needs an interactive terminal. Re-run from a terminal, or use kinu run/exec (or chat --classic).'));
  }));
}

/** opentui's handlers free only the renderer; the TUI ends itself on these. */
export const TUI_EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

/** Canonical read(2) returns at most one line; accumulate until newline or EOF. */
function readLineFromTerminal(fd: number): string | null {
  const buf = Buffer.alloc(1024);
  const chunks: Buffer[] = [];

  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, null);

    if (n === 0) {
      if (chunks.length === 0) return null;
      break;
    }

    chunks.push(Buffer.from(buf.subarray(0, n)));

    if (buf[n - 1] === 0x0a) break;
  }

  return Buffer.concat(chunks).toString('utf8');
}

export function ask(label: string, fallback = ''): Promise<string> {
  return settle(Effect.gen(function* () {
    const tty = openTerminal();

    if (!tty) return yield* Effect.die(new NonInteractiveError());

    return yield* Effect.ensuring(Effect.sync(() => {
      const suffix = fallback ? ` ${DIM(`[${fallback}]`)}` : '';
      process.stdout.write(`${DIM(label)}${suffix} ${ACCENT('›')} `);
      const line = readLineFromTerminal(tty.fd);

      if (line === null) process.stdout.write('\n');

      return (line ?? '').trim() || fallback;
    }), Effect.sync(() => {
      tty.close();
    }));
  }));
}

export async function confirm(label: string, fallback: boolean): Promise<boolean> {
  const answer = (await ask(label, fallback ? 'Y/n' : 'y/N')).trim().toLowerCase();

  if (answer === 'y' || answer === 'yes') return true;

  if (answer === 'n' || answer === 'no') return false;

  return fallback;
}

/** A `sh` child's EXIT trap restores echo even when Ctrl+C kills the group. */
const SECRET_READ = `stty -echo 2>/dev/null; trap 'stty echo 2>/dev/null' EXIT; IFS= read -r line; printf %s "$line"`;

export function askSecret(label: string, fallback = ''): Promise<string> {
  return settle(Effect.gen(function* () {
    const tty = openTerminal();

    if (!tty) return yield* Effect.die(new NonInteractiveError());

    return yield* Effect.ensuring(Effect.gen(function* () {
      process.stdout.write(`${DIM(label)}${fallback ? DIM(' [saved/default]') : ''} ${ACCENT('›')} `);
      const read = spawn('/bin/sh', ['-c', SECRET_READ], { stdio: [tty.fd, 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];

      if (read.stdout === null) return yield* Effect.die(new Error('the secret reader has no stdout pipe'));
      read.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      yield* Effect.promise(async () => once(read, 'close'));
      process.stdout.write('\n');

      return Buffer.concat(chunks).toString('utf8').trim() || fallback;
    }), Effect.sync(() => {
      tty.close();
    }));
  }));
}

/** Enter skips; a `sh` child waits for the key. */
export function skippableOnEnter<T>(label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  return settle(Effect.gen(function* () {
    const controller = new AbortController();
    const tty = openTerminal();

    if (!tty) return yield* Effect.promise(async () => work(controller.signal));
    process.stdout.write(`${DIM(`${label} Enter skips.`)}\n`);
    const reader = spawn('/bin/sh', ['-c', 'IFS= read -r line'], { stdio: [tty.fd, 'ignore', 'ignore'] });
    reader.on('exit', () => controller.abort());

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      return yield* Effect.promise(async () => work(controller.signal));
    }), (failed) => Effect.gen(function* () {
      if (controller.signal.aborted) return null;

      return yield* Effect.failCause(failed);
    })), Effect.sync(() => {
      reader.kill();
      tty.close();
    }));
  }));
}
