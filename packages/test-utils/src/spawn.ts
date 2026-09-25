/** How a child ended, and everything it printed. */
export interface Exited {
  /** Null when a signal ended the child; `signalCode` names it. */
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Written to the child's stdin, then closed; without it, stdin is `/dev/null`. */
  readonly stdin?: string;
}

/**
 * Runs `cmd` to its exit through an async spawn, so suites never spawn synchronously: while bun's `spawnSync`
 * waits (1.4.0 to 1.4.2), a GC finalizer that frees a main-loop poll (an earlier file's stderr sink, a
 * subprocess, a socket) releases it against the wait's private loop, and a later `spawnSync` spins at 100% CPU
 * over a zombie child, forever (oven-sh/bun#34069).
 */
export async function runToExit(cmd: readonly string[], options: RunOptions = {}): Promise<Exited> {
  const child = Bun.spawn([...cmd], {
    cwd: options.cwd,
    env: options.env === undefined ? undefined : { ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode: child.exitCode, signalCode: child.signalCode, stdout, stderr };
}
