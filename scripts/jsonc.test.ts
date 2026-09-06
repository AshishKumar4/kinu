import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { parseJsonc } from './jsonc';

const ConfigSchema = v.object({ literal: v.string(), values: v.array(v.number()) });

test('comments and trailing commas do not change bytes inside strings', () => {
  expect(parseJsonc('/* config */ {"literal": ",}", "values": [1, 2,],}', ConfigSchema, 'config'))
    .toEqual({ literal: ',}', values: [1, 2] });
});

test('repeated commas are invalid rather than silently removed', () => {
  expect(() => parseJsonc('{"literal":"ok","values":[1,,]}', ConfigSchema, 'config')).toThrow();
});

test('an incomplete block comment cannot hide malformed input', () => {
  expect(() => parseJsonc('{"literal":"ok","values":[]} /* incomplete', ConfigSchema, 'config')).toThrow();
});
