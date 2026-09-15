/**
 * `highlightCode` is the one place a code fence becomes coloured tokens — or
 * does not. The defect this pins is the pair a surface cannot recover from:
 * a KNOWN language rendered as flat text (every token the same colour reads
 * as no highlighting at all), and an UNKNOWN language throwing or mangling
 * the source (a fence's first job is to show the code it was handed).
 */
import { describe, expect, test } from 'bun:test';

import { highlightCode } from '../src/components/surfaces/code-highlighter';

describe('highlightCode', () => {
  test('a known grammar comes back as coloured token spans', async () => {
    const result = await highlightCode('const x: number = 1;', 'ts');

    expect(result.html).not.toBeNull();
    // Shiki emits one <span style="color:…"> per token; flat text has none.
    const tokens = result.html!.match(/<span style="color:#/g) ?? [];
    expect(tokens.length).toBeGreaterThan(1);
    // …and the source survives inside the markup, not a paraphrase of it.
    expect(result.html).toContain('const');
    expect(result.code).toBe('const x: number = 1;');
    expect(result.language).toBe('ts');
  });

  test('an alias resolves to its grammar', async () => {
    // `bash` is an alias of `shellscript`; a fence labelled bash is the
    // everyday case.
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
