import { evalWebIdentityEnv } from '@kinu.run/test-utils';

export function requireEqual<Value>(actual: Value, expected: Value): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`contract mismatch: ${JSON.stringify({ actual, expected })}`);
}

/** Production is never a default for this tier's authority. */
export function tierIdentity(env: Record<string, string | undefined>): string {
  const secret = env[evalWebIdentityEnv('https://staging.kinu.run')]?.trim();

  if (!secret) throw new Error('devbox-container-tier requires KINU_EVAL_STAGING_WEB_IDENTITY; production authority is not used');

  return secret;
}
