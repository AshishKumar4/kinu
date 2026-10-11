/**
 * The daemon and its siblings as this repo ships them, read from disk: the CLI imports the daemon as a module (its
 * device.json schema), and Bun gives one file one loader, so a test never imports a daemon file as text.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = join(import.meta.dir, '..', '..', '..', 'pc-agent', 'src');

const read = (name: string): string => readFileSync(join(SOURCE, name), 'utf8');

export const DAEMON_SOURCE = read('index.js');

/** What the daemon requires beside itself: the installer must land each one, byte for byte. */
export const DAEMON_SIBLINGS = {
  'chatgpt.js': read('chatgpt.js'),
  'device-protocol.json': read('device-protocol.json'),
  'pty.js': read('pty.js'),
  'sandbox.js': read('sandbox.js'),
  'update.js': read('update.js'),
} as const;
