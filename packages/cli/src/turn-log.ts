/**
 * Foreground turn diagnostics — where core's shared diagnostics go while a
 * person watches a turn.
 *
 * The default diagnostics sink writes JSON lines to stderr, which on workerd
 * is log collection and under the daemon its journal. In a foreground `kinu
 * chat` or `kinu run` process stderr is the person's own screen, so every
 * diagnostic landed between the reader and their agent — an offline catalog
 * lookup printed raw JSON mid-conversation on every turn. The turn surfaces
 * install this sink instead: the same envelope, appended to the rolling
 * `cli.log` beside `daemon.log`, so nothing is lost and nothing interrupts.
 */

import { join } from 'node:path';
import { classifyErrorCode, createLineLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { AGENT_HOME, ensureAgentHome } from './config';
import { appendDaemonLog } from './daemon-log';

export const TURN_LOG_PATH = join(AGENT_HOME, 'cli.log');

let installed = false;

/** Install once per process. */
export function installTurnDiagnostics(): void {
  if (installed) return;
  installed = true;
  ensureAgentHome();
  setDiagnosticsSink(createLineLogger((line) => {
    try {
      appendDaemonLog(TURN_LOG_PATH, `${line}\n`);
    } catch (caught) {
      // Only an unwritable log file is dropped — a diagnostic must never break
      // the turn it rides on. Any other failure is a bug and still raises.
      if (classifyErrorCode({ cause: caught }) !== 'io') throw caught;
    }
  }));
}
