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

/** The failure of contracts run at once that a tier reports: a contract's own before a `notice` (a platform stall, which
 *  only notes the contracts it kept from running), so one box's stall never hides another box's red. */
export function joinedFailure(ended: readonly PromiseSettledResult<unknown>[], notice: (reason: Error) => boolean): Error {
  const reasons = ended.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason))] : []));

  return reasons.find((reason) => !notice(reason)) ?? reasons[0] ?? new Error('contracts run at once failed and said nothing');
}
