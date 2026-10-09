import { runToExit } from '../../../test-utils/src/spawn';

const parsed = new Map<string, string | undefined>();

export async function shellSyntaxError(command: string): Promise<Error | undefined> {
  if (!parsed.has(command)) {
    const checked = await runToExit(['bash', '-n', '-c', command]);

    parsed.set(command, checked.exitCode === 0 ? undefined : checked.stderr.trim() || `bash -n exited ${checked.exitCode}`);
  }

  const refusal = parsed.get(command);

  return refusal === undefined ? undefined : new Error(`container shell syntax: ${refusal}`);
}

export async function requireShellAccepts(command: string): Promise<void> {
  const refused = await shellSyntaxError(command);

  if (refused !== undefined) throw new Error(`${refused.message}\n${command}`, { cause: refused });
}
