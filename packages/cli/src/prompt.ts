/**
 * Interactive prompt input built on canonical-mode terminal reads.
 *
 * No readline and no raw mode, ever: readline (terminal mode) flips the TTY
 * into raw mode (ECHO and ISIG off) and then relies on the event loop to
 * deliver key bytes. On macOS, kqueue cannot poll the /dev/tty device, so
 * under the installer (`kinu setup </dev/tty`) Bun never delivered a
 * single key: frozen question, no echo, and a dead Ctrl+C. Instead, prompts
 * do a blocking read(2) on the terminal fd in the driver's canonical mode —
 * the kernel handles echo, line editing, and keeps ISIG so Ctrl+C always
 * interrupts. Secrets wrap the same canonical read in `stty -echo` inside a
 * `sh` child whose trap restores echo even when Ctrl+C kills the CLI.
 *
 * Prompts prefer /dev/tty (always a fresh blocking fd) and fall back to a
 * TTY stdin. When no terminal exists at all, prompting raises
 * NonInteractiveError so callers can print instructions instead of hanging.
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
    // No terminal is the everyday absence: ENXIO is what open(2) raises without a
    // controlling terminal, ENOENT when the node itself is missing. Anything else is real.
    if (!(error instanceof Error && 'code' in error && (error.code === 'ENXIO' || error.code === 'ENOENT'))) throw error;
    return process.stdin.isTTY ? { fd: 0, close: () => {} } : null;
  }
}

/** True when a prompt can actually reach a terminal (/dev/tty or TTY stdin). */
export function canPrompt(): boolean {
  const tty = openTerminal();
  if (!tty) return false;
  tty.close();
  return true;
}

/** The opentui TUI drives stdin/stdout directly and cannot reopen /dev/tty —
 *  refuse with instructions instead of rendering a frozen screen. */
export function requireInteractiveTerminal(): void {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  throw new Error('The Kinu TUI needs an interactive terminal. Re-run from a terminal, or use kinu run/exec (or chat --classic).');
}

/** Blocking canonical-mode line read: each read(2) returns at most one line,
 *  so accumulate until newline or EOF (null when EOF arrives with no input). */
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

/** Canonical read with echo disabled by a `sh` child: its EXIT trap restores
 *  echo even when Ctrl+C (still live — ISIG stays on) kills the whole group. */
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
