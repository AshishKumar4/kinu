// A clipboard write can reject (denied permission, insecure origin, unfocused
// document). The label must never claim success for one that did.
import { describe, test, expect } from 'bun:test';
import { copyLabel } from '../src/hooks/use-copy';

describe('copy button label', () => {
  test('only a resolved write reads as copied', () => {
    expect(copyLabel('failed')).not.toBe(copyLabel('copied'));
    expect(copyLabel('failed')).not.toBe(copyLabel('idle'));
    expect(copyLabel('copied')).not.toBe(copyLabel('idle'));
  });

  test('the idle label is the caller\'s, the outcome labels are not', () => {
    expect(copyLabel('idle', 'Copy URL')).toBe('Copy URL');
    expect(copyLabel('failed', 'Copy URL')).toBe(copyLabel('failed'));
    expect(copyLabel('copied', 'Copy URL')).toBe(copyLabel('copied'));
  });
});
