import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { parseJsonc } from './jsonc';

const ConfigSchema = v.object({ literal: v.string(), values: v.array(v.number()) });

test('comments and trailing commas do not change bytes inside strings', () => {
  expect(parseJsonc('/* config */ {"literal": ",}", "values": [1, 2,],}', ConfigSchema, 'config'))
    .toEqual({ literal: ',}', values: [1, 2] });
});

test('a line comment is read past, and a `//` inside a string is kept', () => {
  // Measured: one `//` line in packages/cf-backend/tsconfig.json once took eight gate tests down with
  // `Unrecognized token '/'`. Every tsconfig a gate reads goes through this parse.
  expect(parseJsonc('{ // note\n "literal": "http://x", "values": [] }', ConfigSchema, 'config'))
    .toEqual({ literal: 'http://x', values: [] });
});

test('repeated commas are invalid rather than silently removed', () => {
  expect(() => parseJsonc('{"literal":"ok","values":[1,,]}', ConfigSchema, 'config')).toThrow(SyntaxError);
  expect(parseJsonc('{"literal":"ok","values":[1,]}', ConfigSchema, 'config'))
    .toEqual({ literal: 'ok', values: [1] });
});

test('an incomplete block comment cannot hide malformed input', () => {
  expect(() => parseJsonc('{"literal":"ok","values":[]} /* incomplete', ConfigSchema, 'config')).toThrow(SyntaxError);
  expect(parseJsonc('{"literal":"ok","values":[]} /* complete */', ConfigSchema, 'config'))
    .toEqual({ literal: 'ok', values: [] });
});
