// The CLI run as a person runs it, from a scratch project, with no scheduler daemon: one that is not what a test is
// about outlives the run and races `exec` for the conversation's driver lease.
import { join } from 'node:path';
import { runToExit } from '../../../test-utils/src/spawn';
import { scratchDir } from '../../../test-utils/src/scratch';

export const CLI_BIN = join(import.meta.dir, '../../bin/cli.ts');

/** Where and as whom a run happens: `home` is its KINU_HOME, `cwd` its project (a fresh scratch one by default). */
export interface CliRun {
  readonly home?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

/** `kinu <args>` to its exit, its output uncoloured. */
export function runCli(args: readonly string[], run: CliRun = {}) {
  const env = { ...process.env, KINU_SKIP_DAEMON: '1', NO_COLOR: '1', KINU_HOME: run.home ?? process.env['KINU_HOME'], ...run.env };

  return runToExit([process.execPath, CLI_BIN, ...args], { cwd: run.cwd ?? scratchDir('test-project'), env, stdin: run.stdin });
}
