/**
 * Prompt input via blocking canonical-mode reads on the terminal fd; never readline or raw mode: macOS kqueue cannot
 * poll /dev/tty, so under `kinu setup </dev/tty` keys never arrive. No terminal raises NonInteractiveError.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { ACCENT, DIM } from './display';

class NonInteractiveError extends Error {
  constructor(message = 'This step needs an interactive terminal. Re-run from a terminal, or pass flags to skip prompts.') {
    super(message);
    this.name = 'NonInteractiveError';
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
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  throw new Error('The Kinu TUI needs an interactive terminal. Re-run from a terminal, or use kinu run/exec (or chat --classic).');
}

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

export async function ask(label: string, fallback = ''): Promise<string> {
  const tty = openTerminal();

  if (!tty) throw new NonInteractiveError();

  try {
    const suffix = fallback ? ` ${DIM(`[${fallback}]`)}` : '';
    process.stdout.write(`${DIM(label)}${suffix} ${ACCENT('›')} `);
    const line = readLineFromTerminal(tty.fd);

    if (line === null) process.stdout.write('\n');

    return (line ?? '').trim() || fallback;
  } finally {
    tty.close();
  }
}

export async function confirm(label: string, fallback: boolean): Promise<boolean> {
  const answer = (await ask(label, fallback ? 'Y/n' : 'y/N')).trim().toLowerCase();

  if (answer === 'y' || answer === 'yes') return true;

  if (answer === 'n' || answer === 'no') return false;

  return fallback;
}

/** A `sh` child's EXIT trap restores echo even when Ctrl+C kills the group. */
const SECRET_READ = `stty -echo 2>/dev/null; trap 'stty echo 2>/dev/null' EXIT; IFS= read -r line; printf %s "$line"`;

export async function askSecret(label: string, fallback = ''): Promise<string> {
  const tty = openTerminal();

  if (!tty) throw new NonInteractiveError();

  try {
    process.stdout.write(`${DIM(label)}${fallback ? DIM(' [saved/default]') : ''} ${ACCENT('›')} `);
    const read = spawnSync('/bin/sh', ['-c', SECRET_READ], { stdio: [tty.fd, 'pipe', 'ignore'] });
    process.stdout.write('\n');

    if (read.error) throw read.error;

    return (read.stdout?.toString('utf8') ?? '').trim() || fallback;
  } finally {
    tty.close();
  }
}
