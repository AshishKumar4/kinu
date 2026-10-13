/** The daemon and its siblings as this repo ships them, under the names they install as: the installer must land each one, byte for byte. */
import { settle } from '@kinu.run/core/obs';
import { present } from '@kinu.run/test-utils';
import { buildDaemonFiles } from '../../src/daemon-build';

const built = await settle(buildDaemonFiles());

const sibling = (name: string): string => present(built.siblings.find((file) => file.name === name), `the built ${name}`).source;

export const DAEMON_SOURCE = built.daemon;

/** What the daemon requires beside itself. */
export const DAEMON_SIBLINGS = {
  'chatgpt.js': sibling('chatgpt.js'),
  'device-protocol.json': sibling('device-protocol.json'),
  'pty.js': sibling('pty.js'),
  'sandbox.js': sibling('sandbox.js'),
  'update.js': sibling('update.js'),
} as const;
