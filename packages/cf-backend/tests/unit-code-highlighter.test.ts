/**
 * Defends: a known language rendered as flat text, and an unknown language
 * throwing or mangling the source.
 */
import { describe, expect, test } from 'bun:test';

import { highlightCode } from '../src/components/surfaces/code-highlighter';
import { present } from '@kinu.run/test-utils';

describe('highlightCode', () => {
  test('a known grammar comes back as coloured token spans', async () => {
    const result = await highlightCode('const x: number = 1;', 'ts');

    expect(result.html).not.toBeNull();
    // Shiki emits one <span style="color:…"> per token; flat text has none.
    const tokens = present(result.html, 'the highlighted markup').match(/<span style="color:#/g) ?? [];
    expect(tokens.length).toBeGreaterThan(1);
    expect(result.html).toContain('const');
    expect(result.code).toBe('const x: number = 1;');
    expect(result.language).toBe('ts');
  });

  test('an alias resolves to its grammar', async () => {
    const result = await highlightCode('echo "$HOME"', 'bash');

    expect(result.html).not.toBeNull();
    expect(result.html).toContain('<span');
  });

  test('an unknown language falls back to the plain source', async () => {
    const code = 'plain <unparsed> & text';
    const result = await highlightCode(code, 'not-a-real-grammar');

    expect(result).toEqual({ code, language: 'not-a-real-grammar', html: null });
  });
});
