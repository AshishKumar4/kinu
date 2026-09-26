/** A cloned repo's bunfig and .env stay out of the CLI's Bun. */
export const ISOLATED_BUN_FLAGS: readonly string[] = ['--config=/dev/null', '--no-env-file'];

export function isolatedBunArgs(script: string, args: readonly string[]): string[] {
  return [...ISOLATED_BUN_FLAGS, script, ...args];
}
