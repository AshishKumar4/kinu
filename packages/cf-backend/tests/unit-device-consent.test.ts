import { describe, expect, test } from 'bun:test';
import { DEVICE_CONSENT_SCOPE, summarizeDeviceAction } from '../src/user/device-consent.js';

describe('device consent prompt data', () => {
  test('exec consent shows the exact shell command', () => {
    expect(summarizeDeviceAction('exec', ['echo hi; touch /tmp/x'])).toEqual({
      method: 'exec',
      command: 'echo hi; touch /tmp/x',
    });
  });

  test('helper consent shows the method and path as a local action', () => {
    expect(summarizeDeviceAction('readFile', ['/tmp/a; echo PWNED'])).toEqual({
      method: 'readFile',
      command: 'readFile(/tmp/a; echo PWNED)',
    });
  });

  test('remembered consent scope is the broad local action grant', () => {
    expect(DEVICE_CONSENT_SCOPE).toBe('all_local_actions');
  });
});
