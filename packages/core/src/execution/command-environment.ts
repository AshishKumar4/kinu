/**
 * The owner's secrets granted to a workspace, as variables of every command its agents run there: a placeholder the
 * egress spends only at the secret's hosts, or, on the computer and in eval where the owner let this workspace's
 * agents read it, the value. Only the owner's own calls hold them: a share's viewer, or a shared slate's server, runs
 * commands with none.
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
 * `box` with the secrets under each command's own variables, which win: `HOME` is never a secret's to replace. Never a
 * value, only placeholders (`keep`), for any command: Nimbus writes a Node or Bun program that serves or watches, with
 * its environment, into a generated image every process on the box can read and the box's storage keeps (worker 0.16
 * facets/manager.js:7851-7895, fabric process-fabric.ts:200-214), and a plain command can start one.
 */
export function withCommandEnvironment(box: NimbusSandboxHandle, environment: CommandEnvironment): NimbusSandboxHandle {
  return withCommandOptions(box, async (options) => ({ ...options, env: { ...await environment('keep', secretsCaller()), ...options?.env } }));
}
