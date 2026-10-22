import { ProcessNotAdmitted } from '@nimbus-sh/core/runtime/os-contracts.js';

/**
 * A slate's call sent once more when Nimbus answers that its process's replacement refused it at admission
 * (`ProcessNotAdmitted`, ask 63): it ran nowhere, and the old process reads exited before that answer, so the next
 * `ensure` starts a new one. Only Nimbus's own class: a slate's thrown error crosses as a plain one.
 */
export async function onceMoreIfNotAdmitted<T>(send: () => Promise<T>): Promise<T> {
  const [first] = await Promise.allSettled([send()]);

  if (first.status === 'fulfilled') return first.value;

  if (!(first.reason instanceof ProcessNotAdmitted)) throw first.reason;

  return await send();
}
