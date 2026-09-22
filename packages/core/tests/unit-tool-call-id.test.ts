// The tool-call pairing key minted at a provider boundary (src/providers/tool-call-id.ts). A
// per-response position or provider id repeats across a turn's responses and mispairs results.
import { describe, test, expect } from 'bun:test';
import { isPortableToolCallId, toolCallIdFor } from '../src/providers/tool-call-id';

const FIRST = 'call-chatcmpl-11111111-1111-4111-8111-111111111111';

const SECOND = 'call-chatcmpl-22222222-2222-4222-8222-222222222222';

/** Native ids as each provider family spells them, plus the three unusable classes. */
const NATIVE = {
  openai: 'call_9SxYQ4nCmFVzp0Lr',
  anthropic: 'toolu_01A09q90qw90lq917835lq9',
  counter: '0',
  empty: '',
  whitespace: '   ',
  spaces: 'tool call 1',
  slash: 'read/file',
  unicode: 'appel—1',
  absent: undefined,
} as const;

describe('toolCallIdFor', () => {
  test('a portable native id stays readable inside the key', () => {
    expect(toolCallIdFor({ scope: FIRST, native: NATIVE.openai, index: 0 }))
      .toBe(`${FIRST}-n-${NATIVE.openai}`);
    expect(toolCallIdFor({ scope: FIRST, native: NATIVE.anthropic, index: 3 }))
      .toBe(`${FIRST}-n-${NATIVE.anthropic}`);
    // Surrounding whitespace is not part of an id.
    expect(toolCallIdFor({ scope: FIRST, native: `\t${NATIVE.openai}\n`, index: 0 }))
      .toBe(`${FIRST}-n-${NATIVE.openai}`);
  });

  test('an unusable native id degrades to the position, never to an empty key', () => {
    for (const native of [NATIVE.empty, NATIVE.whitespace, NATIVE.spaces, NATIVE.slash, NATIVE.unicode, NATIVE.absent, null]) {
      expect(toolCallIdFor({ scope: FIRST, native, index: 0 })).toBe(`${FIRST}-i-1`);
      expect(toolCallIdFor({ scope: FIRST, native, index: 4 })).toBe(`${FIRST}-i-5`);
    }
  });

  test('the same native id in two responses cannot produce the same key', () => {
    // Same value in two responses of one turn: the collision a position or empty id causes.
    for (const native of Object.values(NATIVE)) {
      expect(toolCallIdFor({ scope: FIRST, native, index: 0 }))
        .not.toBe(toolCallIdFor({ scope: SECOND, native, index: 0 }));
    }
  });

  test('a native positional id and an unnamed call occupy disjoint namespaces', () => {
    expect(toolCallIdFor({ scope: FIRST, native: '1', index: 0 })).toBe(`${FIRST}-n-1`);
    expect(toolCallIdFor({ scope: FIRST, index: 0 })).toBe(`${FIRST}-i-1`);
  });

  test('two calls in one response never collide', () => {
    const natives = Object.values(NATIVE);
    const keys = natives.map((native, index) => toolCallIdFor({ scope: FIRST, native, index }));
    expect(new Set(keys).size).toBe(keys.length);
    // Two unnamed calls in one response are told apart by position alone.
    expect(toolCallIdFor({ scope: FIRST, index: 0 }))
      .not.toBe(toolCallIdFor({ scope: FIRST, index: 1 }));
  });

  test('every key is portable, whatever the native id carried', () => {
    for (const [index, native] of Object.values(NATIVE).entries()) {
      const key = toolCallIdFor({ scope: FIRST, native, index });
      expect(isPortableToolCallId(key)).toBe(true);
    }
  });

  test('re-feeding a key as the native id is a fixed point', () => {
    // A replayed id arrives back as the provider's own; scoping it twice would break its result's pairing.
    for (const [index, native] of Object.values(NATIVE).entries()) {
      const once = toolCallIdFor({ scope: FIRST, native, index });
      expect(toolCallIdFor({ scope: FIRST, native: once, index })).toBe(once);
      // Idempotence is a property of the key, not the offset it was minted at.
      expect(toolCallIdFor({ scope: FIRST, native: once, index: index + 7 })).toBe(once);
    }
  });

  test('a key from another response is not a fixed point of this one', () => {
    // A different response scope: the first response's key is re-keyed, not adopted.
    const foreign = toolCallIdFor({ scope: SECOND, native: NATIVE.counter, index: 0 });
    expect(toolCallIdFor({ scope: FIRST, native: foreign, index: 0 })).toBe(`${FIRST}-n-${foreign}`);
  });
});

describe('isPortableToolCallId', () => {
  test('the ASCII identifier set round-trips, nothing else does', () => {
    for (const id of [NATIVE.openai, NATIVE.anthropic, NATIVE.counter, 'a.b:c-d_e', FIRST]) {
      expect(isPortableToolCallId(id)).toBe(true);
    }

    for (const id of [NATIVE.empty, NATIVE.whitespace, NATIVE.spaces, NATIVE.slash, NATIVE.unicode, 'a\nb', '{"id":1}']) {
      expect(isPortableToolCallId(id)).toBe(false);
    }
  });
});
