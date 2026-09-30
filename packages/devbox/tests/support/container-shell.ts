import { spawnSync } from 'node:child_process';

const parsed = new Map<string, string | undefined>();

export function shellSyntaxError(command: string): Error | undefined {
  if (!parsed.has(command)) {
    const checked = spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8' });

    if (checked.error !== undefined) throw checked.error;
    parsed.set(command, checked.status === 0 ? undefined : checked.stderr.trim() || `bash -n exited ${checked.status}`);
  }

  const refusal = parsed.get(command);

  return refusal === undefined ? undefined : new Error(`container shell syntax: ${refusal}`);
}

export function requireShellAccepts(command: string): void {
  const refused = shellSyntaxError(command);

  if (refused !== undefined) throw new Error(`${refused.message}\n${command}`, { cause: refused });
}
