// A clipboard write can reject (denied permission, insecure origin, unfocused
// document). The label must never claim success for one that did.
import { describe, test, expect } from 'bun:test';
import { copyLabel } from '../src/hooks/use-copy.ts';

describe('copy button label', () => {
  test('only a resolved write reads as copied', () => {
    expect(copyLabel('copied')).toBe('Copied!');
    expect(copyLabel('failed')).toBe('Copy failed');
    expect(copyLabel('idle')).toBe('Copy');
  });

  test('the idle label is the caller\'s, the outcome labels are not', () => {
    expect(copyLabel('idle', 'Copy URL')).toBe('Copy URL');
    expect(copyLabel('failed', 'Copy URL')).toBe('Copy failed');
  });
});
