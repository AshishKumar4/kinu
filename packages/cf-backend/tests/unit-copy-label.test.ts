// A clipboard write can reject; the label must never claim success for one that did.
import { describe, test, expect } from 'bun:test';
import { copyLabel } from '../src/hooks/use-copy';

describe('copy button label', () => {
  test('only a resolved write reads as copied', () => {
    expect(copyLabel('failed')).not.toBe(copyLabel('copied'));
    expect(copyLabel('failed')).not.toBe(copyLabel('idle'));
    expect(copyLabel('copied')).not.toBe(copyLabel('idle'));
  });
});
