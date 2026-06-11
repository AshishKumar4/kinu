/**
 * Interactive prompt input that survives `curl | bash` and piped stdin.
 *
 * Prompts read from stdin when it is a real terminal, otherwise they reopen
 * the controlling terminal (/dev/tty) — readline on a pipe either swallows
 * stray bytes as the "answer" or hits EOF and never resolves, which is how
 * the installer's sign-in question used to freeze. When no terminal exists
 * at all, prompting raises NonInteractiveError so callers can print
 * instructions instead of hanging.
 */
import { closeSync, openSync } from 'node:fs';
import * as readline from 'node:readline';
import * as tty from 'node:tty';
import { ACCENT, DIM } from './display.js';

export class NonInteractiveError extends Error {
  constructor(message = 'This step needs an interactive terminal. Re-run from a terminal, or pass flags to skip prompts.') {
    super(message);
    this.name = 'NonInteractiveError';
  }
}

interface PromptInput {
  stream: tty.ReadStream | (typeof process.stdin);
  release: () => void;
}

function openPromptInput(): PromptInput | null {
  if (process.stdin.isTTY) {
    return { stream: process.stdin, release: () => {} };
  }
  try {
    const stream = new tty.ReadStream(openSync('/dev/tty', 'r'));
    return { stream, release: () => stream.destroy() };
  } catch {
    return null;
  }
}

/** True when a prompt can actually reach a terminal (stdin TTY or /dev/tty). */
export function canPrompt(): boolean {
  if (process.stdin.isTTY) return true;
  try {
    closeSync(openSync('/dev/tty', 'r'));
    return true;
  } catch {
    return false;
  }
}

/** The opentui TUI drives stdin/stdout directly and cannot reopen /dev/tty —
 *  refuse with instructions instead of rendering a frozen screen. */
export function requireInteractiveTerminal(): void {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  throw new Error('The Proteus TUI needs an interactive terminal. Re-run from a terminal, or use proteus run/exec (or chat --classic) for non-interactive use.');
}

export async function ask(label: string, fallback = ''): Promise<string> {
  const input = openPromptInput();
  if (!input) throw new NonInteractiveError();
  const rl = readline.createInterface({ input: input.stream, output: process.stdout });
  try {
    const suffix = fallback ? ` ${DIM(`[${fallback}]`)}` : '';
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${DIM(label)}${suffix} ${ACCENT('›')} `, resolve);
    });
    return answer.trim() || fallback;
  } finally {
    rl.close();
    input.release();
  }
}

export async function confirm(label: string, fallback: boolean): Promise<boolean> {
  const answer = (await ask(label, fallback ? 'Y/n' : 'y/N')).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  return fallback;
}

export async function askSecret(label: string, fallback = ''): Promise<string> {
  const input = openPromptInput();
  if (!input) throw new NonInteractiveError();
  const stream = input.stream;
  if (typeof stream.setRawMode !== 'function' || !process.stdout.isTTY) {
    input.release();
    return ask(label, fallback);
  }

  process.stdout.write(`${DIM(label)}${fallback ? DIM(' [saved/default]') : ''} ${ACCENT('›')} `);
  stream.setRawMode(true);
  stream.resume();
  stream.setEncoding('utf8');
  let value = '';
  return new Promise<string>((resolve) => {
    const finish = (result?: string) => {
      stream.setRawMode(false);
      stream.off('data', onData);
      input.release();
      process.stdout.write('\n');
      if (result === undefined) process.exit(130);
      resolve(result);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          finish();
          return;
        }
        if (ch === '\r' || ch === '\n') {
          finish(value.trim() || fallback);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += ch;
        process.stdout.write('*');
      }
    };
    stream.on('data', onData);
  });
}
