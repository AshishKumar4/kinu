/**
 * Rotation is copy-truncate, not rename: the detached daemon's stdout/stderr are an inherited `O_APPEND` fd on this file,
 * and a rename would leave that handle writing to the rotated file uncapped.
 */

import { appendFileSync, copyFileSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { tolerate } from '@kinu.run/core/obs';

/** Rotate at 1 MiB, keeping one predecessor. */
const DAEMON_LOG_MAX_BYTES = 1024 * 1024;

const PREVIOUS_SUFFIX = '.1';

/** A missing log has nothing to roll; any other failure throws, since it breaks the cap. */
export function rotateDaemonLogIfNeeded(path: string, maxBytes: number = DAEMON_LOG_MAX_BYTES): boolean {
  const size = tolerate(() => statSync(path).size, 'enoent');

  if (size === undefined || size < maxBytes) return false;
  copyFileSync(path, `${path}${PREVIOUS_SUFFIX}`);
  truncateSync(path, 0);

  return true;
}

export function appendDaemonLog(path: string, line: string, maxBytes: number = DAEMON_LOG_MAX_BYTES): void {
  rotateDaemonLogIfNeeded(path, maxBytes);
  appendFileSync(path, line);
}

/** Reads across a rotation. Null when nothing has ever been logged. */
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

  if (lines[lines.length - 1] === '') lines.pop();

  return lines;
}
