/**
 * One signal to a whole process GROUP.
 *
 * Both browser harnesses spawn children that lead groups of their own, so a
 * signal aimed at the runner's group reaches none of them: puppeteer spawns
 * Chrome detached on POSIX (`@puppeteer/browsers` launch.js:158 —
 * `opts.detached ??= process.platform !== 'win32'`), and `vite dev` is spawned
 * detached on purpose so workerd can be reached through its group. `-group`
 * reaches every member at once — the browser's zygotes, renderers, GPU and
 * network processes; vite's workerd children.
 */

import { tolerate } from '@kinu.run/core/obs';

/** `undefined` is a child that never got a pid — a launch that failed, whose
 *  own close owns it. An already-exited group raises ESRCH, an expected
 *  absence here. */
export function signalGroup(group: number | undefined, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (group === undefined) return;

  tolerate(() => process.kill(-group, signal), 'esrch');
}
