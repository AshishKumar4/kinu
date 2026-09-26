import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { dirname } from 'node:path';

/** Bun reads its start directory's bunfig and .env; a child of the CLI must not take a cloned repo's. */
export function isolatedBunArgs(script: string, args: readonly string[]): string[] {
  return ['--config=/dev/null', '--no-env-file', script, ...args];
}

export function spawnKinuScript(script: string, args: readonly string[], options: Omit<SpawnOptions, 'cwd'>): ChildProcess {
  return spawn(process.execPath, isolatedBunArgs(script, args), { ...options, cwd: dirname(script) });
}
