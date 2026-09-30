import { spawnSync } from 'node:child_process';

/** What a test does to one exec before it runs: `refuse` fails it with nothing started, `lose`
 *  starts it and then fails the call, as an answer lost after the spawn does. */
export type ExecFault = { readonly kind: 'refuse' | 'lose'; readonly error: Error } | undefined;

/** The runtime's `Container` as `docker exec` into a running container of the real image, so the
 *  process scripts run in its `/bin/sh` and the SDK's file calls reach its `sandbox-shim`. A missing
 *  `cwd` is refused before anything runs, which is what review 3f6 saw the platform do. */
export function dockerContainer(name: string, fault: (argv: readonly string[]) => ExecFault = () => undefined): Container {
  const unmodelled = (member: string): never => { throw new Error(`docker exec does not model container.${member}`); };

  return {
    get running() { return true; },
    get images() { return {}; },
    start: () => unmodelled('start'),
    monitor: () => unmodelled('monitor'),
    destroy: () => unmodelled('destroy'),
    signal: () => unmodelled('signal'),
    getTcpPort: () => unmodelled('getTcpPort'),
    setInactivityTimeout: () => unmodelled('setInactivityTimeout'),
    interceptOutboundHttp: () => unmodelled('interceptOutboundHttp'),
    interceptAllOutboundHttp: () => unmodelled('interceptAllOutboundHttp'),
    interceptOutboundHttps: () => unmodelled('interceptOutboundHttps'),
    snapshotContainer: () => unmodelled('snapshotContainer'),
    inspect: () => unmodelled('inspect'),
    exec: async (argv, options = {}) => {
      const injected = fault(argv);

      if (injected?.kind === 'refuse') throw injected.error;

      if (options.stdin !== undefined && options.stdin !== 'pipe') return unmodelled('exec with a stdin stream');

      if (options.cwd !== undefined && inContainer(name, ['test', '-d', options.cwd]).status !== 0) {
        throw new Error(`exec refused: chdir to cwd ("${options.cwd}") failed: no such file or directory`);
      }

      const flags = [
        'exec', '-i', ...options.cwd === undefined ? [] : ['-w', options.cwd],
        ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      ];

      const child = Bun.spawn(['docker', ...flags, name, ...argv], {
        stdin: 'pipe',
        stdout: options.stdout === 'ignore' ? 'ignore' : 'pipe',
        stderr: options.stderr === 'ignore' ? 'ignore' : 'pipe',
      });

      options.signal?.addEventListener('abort', () => { child.kill(); }, { once: true });

      const input = options.stdin === 'pipe'
        ? new WritableStream<Uint8Array>({
          write: async (chunk) => { await child.stdin.write(chunk); await child.stdin.flush(); },
          close: async () => { await child.stdin.end(); },
          abort: async () => { await child.stdin.end(); },
        })
        : null;

      if (input === null) await child.stdin.end();

      if (injected?.kind === 'lose') throw injected.error;
      const stdout = child.stdout ?? null;
      const stderr = child.stderr ?? null;

      return {
        pid: child.pid,
        isPty: false,
        stdin: input,
        stdout,
        stderr,
        exitCode: child.exited,
        output: async () => {
          const [out, err, exitCode] = await Promise.all([
            new Response(stdout).arrayBuffer(), new Response(stderr).arrayBuffer(), child.exited,
          ]);

          return { stdout: out, stderr: err, exitCode };
        },
        kill: (signal) => { child.kill(signal); },
        resize: () => unmodelled('exec resize'),
      };
    },
  };
}

/** One command in the container, run to its end. */
export function inContainer(name: string, argv: readonly string[]) {
  const ran = spawnSync('docker', ['exec', name, ...argv], { encoding: 'utf8' });

  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}
