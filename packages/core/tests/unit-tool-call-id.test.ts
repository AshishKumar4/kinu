// The tool-call pairing key minted at a provider boundary
// (src/providers/tool-call-id.ts).
//
// The id is the ONLY thing joining a tool call to its result: the transcript
// pairs them by it and the surface renders a row by it. Two ways of getting it
// wrong were live at the same time. A per-response POSITION repeats on the next
// response of a turn, so the second step's result pairs with the first step's
// call. Forwarding whatever the provider called it repeats the same collision
// whenever the provider's own id is per-response ("0", "1") or empty — an empty
// id pairs with every other empty id.
//
// The cases below are the shapes each family actually replays: an
// OpenAI-compatible `call_<random>`, an Anthropic `toolu_<random>`, a
// per-response counter, an empty or whitespace id, an id carrying characters no
// JSON id field round-trips, and no id at all.
import { describe, test, expect } from 'bun:test';
import { isPortableToolCallId, toolCallIdFor } from '../src/providers/tool-call-id';

const FIRST = 'call-chatcmpl-11111111-1111-4111-8111-111111111111';
const SECOND = 'call-chatcmpl-22222222-2222-4222-8222-222222222222';

/** Native ids as each provider family spells them, plus the three unusable
 *  classes. */
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
    // The collision the position had, and the one a per-response counter or an
    // empty id reproduces: same value, two responses of one turn.
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
    // What a replayed transcript does: the persisted id arrives back as the
    // provider's own. Scoping it twice would rewrite the pairing key of a call
    // whose result is already keyed on the first value.
    for (const [index, native] of Object.values(NATIVE).entries()) {
      const once = toolCallIdFor({ scope: FIRST, native, index });
      expect(toolCallIdFor({ scope: FIRST, native: once, index })).toBe(once);
      // Idempotence is a property of the key, not of the position it was
      // minted at: a replay that reads it at another offset keeps it.
      expect(toolCallIdFor({ scope: FIRST, native: once, index: index + 7 })).toBe(once);
    }
  });

  test('a key from another response is not a fixed point of this one', () => {
    // Two responses, so the scope differs: the first response's key does not
    // start with this scope and is re-keyed here rather than adopted.
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
