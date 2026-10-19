/**
 * The owner's secrets granted to a workspace, as variables of every command its agents run there: a placeholder the
 * egress spends only at the secret's hosts, or, where the owner let this workspace's agents read it, the value.
 */

import type { NimbusSandboxHandle } from './nimbus';
import { withCommandOptions } from './node-home';

/**
 * `run`: a command run now, where a value its agents may read stands in place of its placeholder. `keep`: a process
 * Kinu restarts by itself later, which holds placeholders only, since a value is never kept.
 */
export type CommandEnvironment = (use: 'run' | 'keep') => Promise<Readonly<Record<string, string>>>;

/** `box` with the secrets under each command's own variables, which win: `HOME` is never a secret's to replace. */
export function withCommandEnvironment(box: NimbusSandboxHandle, environment: CommandEnvironment): NimbusSandboxHandle {
  return withCommandOptions(box, async (options, kept) => ({ ...options, env: { ...await environment(kept ? 'keep' : 'run'), ...options?.env } }));
}
