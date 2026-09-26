import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { dirname } from 'node:path';
import { isolatedBunArgs } from '@kinu.run/core';

export function spawnKinuScript(script: string, args: readonly string[], options: Omit<SpawnOptions, 'cwd'>): ChildProcess {
  return spawn(process.execPath, isolatedBunArgs(script, args), { ...options, cwd: dirname(script) });
}
