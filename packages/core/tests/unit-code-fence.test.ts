import { describe, expect, test } from 'bun:test';
import { canonicalLanguage, fencedBlocks, readProposalCode } from '../src/execution/code-fence';

const JAVASCRIPT = ['javascript'] as const;

describe('fenced proposal code', () => {
  test('normalizes model fence aliases without losing unknown languages', () => {
    expect(canonicalLanguage('JS')).toBe('javascript');
    expect(canonicalLanguage('python3')).toBe('python');
    expect(canonicalLanguage('rust')).toBe('rust');
    expect(canonicalLanguage('')).toBeNull();
  });

  test('reads all non-empty blocks in source order', () => {
    expect(fencedBlocks('```js title=demo.js\na\n```\n```python\nb\n```')).toEqual([
      { language: 'javascript', code: 'a' },
      { language: 'python', code: 'b' },
    ]);
  });

  test('uses the last runnable implementation and preserves its language', () => {
    const proposal = 'first\n```js\nconst value = 0;\n```\nfixed\n```js\nconst value = 1;\n```';
    expect(readProposalCode(proposal, JAVASCRIPT)).toEqual({
      kind: 'runnable', language: 'javascript', code: 'const value = 1;',
    });
  });

  test('treats an untagged fence as the requested primary language', () => {
    expect(readProposalCode('```\nprint(1)\n```', ['python'])).toEqual({
      kind: 'runnable', language: 'python', code: 'print(1)',
    });
  });

  test('distinguishes unsupported code from prose', () => {
    expect(readProposalCode('```python\nprint(1)\n```', JAVASCRIPT)).toEqual({
      kind: 'unrunnable', language: 'python',
    });
    expect(readProposalCode('Rewrite the parser.', JAVASCRIPT)).toBeNull();
  });

  test('prefers any runnable block over an unsupported alternative', () => {
    const proposal = '```js\nconst value = 1;\n```\n```python\nvalue = 1\n```';
    expect(readProposalCode(proposal, JAVASCRIPT)).toMatchObject({
      kind: 'runnable', language: 'javascript', code: 'const value = 1;',
    });
  });
});
