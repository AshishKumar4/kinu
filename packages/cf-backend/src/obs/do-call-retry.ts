import type { DoCallRetryInfo } from '@nimbus-sh/fabric/do-calls.js';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';

export function logDoCallRetry({ operation, classification, attempt, maxAttempts, error }: DoCallRetryInfo): void {
  diagnostics.failure('do_rpc.transient_retry', toKinuError({
    doing: `an idempotent Durable Object call (${operation})`,
    cause: error,
    otherwise: 'io',
  }), { operation, transient: classification, attempt, attempts: maxAttempts });
}
