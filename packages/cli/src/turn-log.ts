/** Foreground diagnostics go to `cli.log`: stderr is the person's screen. */

import { join } from 'node:path';
import { classifyErrorCode, createLineLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { AGENT_HOME, ensureAgentHome } from './config';
import { appendDaemonLog } from './daemon-log';

const TURN_LOG_PATH = join(AGENT_HOME, 'cli.log');

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
      // Only an unwritable log is dropped; a diagnostic must not break its turn. Other failures raise.
      if (classifyErrorCode({ cause: caught }) !== 'io') throw caught;
    }
  }));
}
