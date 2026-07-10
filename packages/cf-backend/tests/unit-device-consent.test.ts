import { describe, expect, test } from 'bun:test';
import {
  DEVICE_CONSENT_SCOPE, DEVICE_CONSENT_SCOPE_FULL_FS,
  mergeConsentScope, parseConsentScope, summarizeDeviceAction,
} from '../src/user/device-consent.js';

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

describe('consent tiers (the /pc mount scope)', () => {
  test('the full-filesystem tier is a distinct, never-default scope', () => {
    expect(DEVICE_CONSENT_SCOPE_FULL_FS).toBe('full_filesystem');
    expect(parseConsentScope(undefined)).toBe(DEVICE_CONSENT_SCOPE);
    expect(parseConsentScope(null)).toBe(DEVICE_CONSENT_SCOPE);
    expect(parseConsentScope('garbage')).toBe(DEVICE_CONSENT_SCOPE);
    expect(parseConsentScope('full_filesystem')).toBe(DEVICE_CONSENT_SCOPE_FULL_FS);
  });

  test('remembering a base action grant never downgrades full_filesystem', () => {
    expect(mergeConsentScope('full_filesystem', DEVICE_CONSENT_SCOPE)).toBe(DEVICE_CONSENT_SCOPE_FULL_FS);
    expect(mergeConsentScope('all_local_actions', DEVICE_CONSENT_SCOPE)).toBe(DEVICE_CONSENT_SCOPE);
    expect(mergeConsentScope(null, DEVICE_CONSENT_SCOPE_FULL_FS)).toBe(DEVICE_CONSENT_SCOPE_FULL_FS);
    expect(mergeConsentScope('garbage', DEVICE_CONSENT_SCOPE)).toBe(DEVICE_CONSENT_SCOPE);
  });
});
