/** One application identity across provider calls and intercepted traffic. */
export const KINU_USER_AGENT = 'Kinu (+https://kinu.run)';

const PRINTABLE_FIELD_VALUE = /^[\x20-\x7E]+$/;

/** RFC 9110: Kinu's product token precedes a valid caller suffix. */
export function kinuUserAgent(callerUserAgent: string | null): string {
  const caller = callerUserAgent?.trim() ?? '';

  if (!caller || !PRINTABLE_FIELD_VALUE.test(caller)) return KINU_USER_AGENT;

  if (caller.startsWith(KINU_USER_AGENT)) return caller;

  return `${KINU_USER_AGENT} ${caller}`;
}
