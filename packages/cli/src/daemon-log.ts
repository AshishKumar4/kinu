/**
 * The local scheduler daemon's log, capped.
 *
 * `daemon.log` grew forever: every tick, every turn, every error appended and
 * nothing ever reclaimed. This module owns the whole "the log is a rolling
 * pair" problem — callers append a line or ask for the tail and never learn
 * that a predecessor file exists.
 *
 * Rotation is **copy-truncate**, not rename, and that is the load-bearing
 * decision. The daemon is spawned detached with its stdout/stderr inherited
 * from an `O_APPEND` fd on this exact file, so crash output and any `console.*`
 * from a tick go through a handle we cannot make reopen. Renaming would leave
 * that handle writing into the rotated file forever — uncapped, and clobbered
 * by the next rotation. Truncating in place keeps the inode, so both writers
 * stay on the live file and the cap holds for both.
 */

import { appendFileSync, copyFileSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { tolerate } from '@kinu/core/obs';

/** Rotate at 1 MiB, keeping exactly one predecessor: ~2 MiB of history is
 *  plenty to explain a misfiring trigger and costs nothing to keep. */
export const DAEMON_LOG_MAX_BYTES = 1024 * 1024;

const PREVIOUS_SUFFIX = '.1';

/** Roll the log over when it has outgrown the cap. Returns whether it rolled.
 *  A log that does not exist yet has nothing to roll; a rotation that fails for
 *  any other reason has silently broken the cap and must be heard. */
export function rotateDaemonLogIfNeeded(path: string, maxBytes: number = DAEMON_LOG_MAX_BYTES): boolean {
  const size = tolerate(() => statSync(path).size, 'enoent');
  if (size === undefined || size < maxBytes) return false;
  copyFileSync(path, `${path}${PREVIOUS_SUFFIX}`);
  truncateSync(path, 0);
  return true;
}

/** Append one already-terminated line, rotating first when due. */
export function appendDaemonLog(path: string, line: string, maxBytes: number = DAEMON_LOG_MAX_BYTES): void {
  rotateDaemonLogIfNeeded(path, maxBytes);
  appendFileSync(path, line);
}

/**
 * The last `maxLines` lines of the log, reading across a rotation so a roll
 * that just happened does not look like the daemon lost its history. Null when
 * nothing has ever been logged.
 */
export function readDaemonLogTail(path: string, maxLines: number): string | null {
  const previous = readLines(`${path}${PREVIOUS_SUFFIX}`);
  const current = readLines(path);
  if (previous === null && current === null) return null;
  return [...(previous ?? []), ...(current ?? [])].slice(-maxLines).join('\n');
}

function readLines(path: string): string[] | null {
  const content = tolerate(() => readFileSync(path, 'utf-8'), 'enoent');
  if (content === undefined) return null;
  const lines = content.split('\n');
  // A trailing newline yields a final empty element that is not a line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
