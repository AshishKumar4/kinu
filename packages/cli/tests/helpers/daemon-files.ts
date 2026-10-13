/**
 * The daemon and its siblings as this repo ships them, staged into a scratch directory under the names they install
 * as: the installer must land each one, byte for byte.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';

/** Copies every file the daemon ships into `into`, the daemon as pc-agent.js. */
function stageShippedDaemon(into: string): void {
  const source = join(import.meta.dir, '..', '..', '..', 'pc-agent', 'src');

  mkdirSync(into, { recursive: true });

  for (const name of readdirSync(source)) {
    if (name.endsWith('.d.ts') || !(name.endsWith('.js') || name.endsWith('.json'))) continue;
    writeFileSync(join(into, name === 'index.js' ? 'pc-agent.js' : name), readFileSync(join(source, name)));
  }
}

const STAGED = scratchDir('shipped-daemon');

stageShippedDaemon(STAGED);

const staged = (name: string): string => readFileSync(join(STAGED, name), 'utf8');

export const DAEMON_SOURCE = staged('pc-agent.js');

/** What the daemon requires beside itself. */
export const DAEMON_SIBLINGS = {
  'chatgpt.js': staged('chatgpt.js'),
  'device-protocol.json': staged('device-protocol.json'),
  'pty.js': staged('pty.js'),
  'sandbox.js': staged('sandbox.js'),
  'update.js': staged('update.js'),
} as const;
