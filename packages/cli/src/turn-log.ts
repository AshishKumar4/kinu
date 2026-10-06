/** Foreground diagnostics go to `cli.log`: stderr is the person's screen. */

import { join } from 'node:path';
import { Cause, Effect } from 'effect';
import { classifyErrorCode, createLineLogger, setDiagnosticsSink, settleSync } from '@kinu.run/core/obs';
import { AGENT_HOME, ensureAgentHome } from './config';
import { appendDaemonLog } from './daemon-log';

const TURN_LOG_PATH = join(AGENT_HOME, 'cli.log');

/** Installed by the CLI's entry; the home is made at the first line, so `kinu --help` makes none. */
export function installTurnDiagnostics(): void {
  // Only an unwritable log is dropped; a diagnostic must not break its turn. Other failures raise.
  setDiagnosticsSink(createLineLogger((line) => settleSync(Effect.catchCause(Effect.sync(() => {
    ensureAgentHome();
    appendDaemonLog(TURN_LOG_PATH, `${line}\n`);
  }), (failed) => {
    const caught = Cause.squash(failed);

    return classifyErrorCode({ cause: caught }) === 'io' ? Effect.void : Effect.die(caught);
  }))));
}
