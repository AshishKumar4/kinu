/**
 * The owner's secrets granted to a workspace, as variables of every command its agents run there: a placeholder the
 * egress spends only at the secret's hosts, or, where the owner let this workspace's agents read it, the value. Only
 * the owner's own calls hold them: a share's viewer, or a shared slate's server, runs commands with none.
 */

import type { NimbusSandboxHandle } from './nimbus';
import { withCommandOptions } from './node-home';
import { secretsCaller, type SecretsCaller } from './secrets-caller';

/**
 * `run`: values a command or process lives with only in memory, so one the owner let this workspace's agents read
 * stands in place of its placeholder. `keep`: what may be written down and read again later (a supervised job's spec,
 * a slate's server), which holds placeholders only. A `viewer` gets nothing either way.
 */
export type CommandEnvironment = (use: 'run' | 'keep', caller: SecretsCaller) => Promise<Readonly<Record<string, string>>>;

/**
 * `box` with the secrets under each command's own variables, which win: `HOME` is never a secret's to replace. A process
 * the box keeps running holds them in memory as a command does: the box neither writes nor restarts it.
 */
export function withCommandEnvironment(box: NimbusSandboxHandle, environment: CommandEnvironment): NimbusSandboxHandle {
  return withCommandOptions(box, async (options) => ({ ...options, env: { ...await environment('run', secretsCaller()), ...options?.env } }));
}
