import * as v from 'valibot';
import type { Shell, ShellExecOptions } from '../../src/types/primitives';

/** A machine's own shell: each call a fresh `sh -c` in `home`, its stdout handed on as it arrives. */
export function scratchMachine(home: string): Shell {
  return {
    async exec(command, stdinOrOptions) {
      const options: ShellExecOptions = v.is(v.string(), stdinOrOptions) ? { stdin: stdinOrOptions } : stdinOrOptions ?? {};

      const child = Bun.spawn(['sh', '-c', command], {
        cwd: home, env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe',
      });

      const chunks: Uint8Array[] = [];

      for await (const chunk of child.stdout) {
        chunks.push(chunk);
        options.output?.write('stdout', chunk);
      }

      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

      return { stdout: Buffer.concat(chunks).toString('utf8'), stderr, exitCode };
    },
  };
}
