import { dirname, resolve } from 'node:path';

/** The one daemon instance: its binary, the tree it backs, and its control surface. */
export interface JournalDaemonPaths {
  readonly binary: string;
  readonly root: string;
  readonly mount: string;
  readonly state: string;
  readonly socket: string;
}

/**
 * The daemon's exact argv, shared by the in-container spawn and by a host that
 * supervises the daemon as a container process. Both must name one binary and
 * one path set, or a fence would answer for a different tree.
 */
export function journalDaemonArgv(options: JournalDaemonPaths): readonly string[] {
  const root = resolve(options.root);
  const mount = resolve(options.mount);
  const state = resolve(options.state);
  const socket = resolve(options.socket);
  if (dirname(socket) !== state) throw new Error('journal control socket must live directly in its private state directory');
  return [options.binary, '--root', root, '--mount', mount, '--state', state, '--socket', socket];
}
