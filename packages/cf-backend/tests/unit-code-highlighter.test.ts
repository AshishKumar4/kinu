// Defends: an alias missing its grammar; an unknown language mangling the source. Colour: chat-and-files-ux.
import { describe, expect, test } from 'bun:test';

import { highlightCode } from '../src/components/surfaces/code-highlighter';

describe('highlightCode', () => {
  test('a known grammar comes back as markup that keeps its source', async () => {
    const result = await highlightCode('const x: number = 1;', 'ts');

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
