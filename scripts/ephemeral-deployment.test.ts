import { describe, expect, test } from 'bun:test';

import { WRANGLER_FAILED, wranglerProvesAbsence } from './ephemeral-deployment';

describe('Worker absence', () => {
  test('authentication and network failures never prove Worker absence', () => {
    expect(wranglerProvesAbsence(`${WRANGLER_FAILED}: Authentication error`)).toBe(false);
    expect(wranglerProvesAbsence(`${WRANGLER_FAILED}: network timeout`)).toBe(false);
    expect(wranglerProvesAbsence(`${WRANGLER_FAILED}: Worker not found`)).toBe(true);
  });
});
