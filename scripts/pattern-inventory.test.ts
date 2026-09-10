import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { buildPatternInventory, inventoryJavaScript } from './pattern-inventory';

test('the AST distinguishes patterns from comments, division and quoted source', () => {
  const sites = inventoryJavaScript('scripts/fixture.ts', [
    'const token = /abc/u;',
    'const composed = new RegExp(input);',
    'const division = a / b;',
    'const quoted = "/not-a-pattern/";',
    '// /not-a-pattern/',
  ].join('\n'));

  expect(sites.map(site => [site.kind, site.category])).toEqual([
    ['regex-literal', 'lexical'], ['regexp-constructor', 'composition'],
  ]);
});

test('code extraction and character scanners enter candidate review', () => {
  const source = 'const declaration = /^export\\s+class (\\w+)/;\n'
    + 'function scanName(text: string) { let out = ""; for (let i=0;i<text.length;i++) out += text[i]; return out; }';

  const result = buildPatternInventory(new Map([['scripts/new-reader.ts', source]]));
  expect(result.candidates.map(site => [site.kind, site.decision])).toEqual([
    ['regex-literal', null], ['hand-parser', null],
  ]);
});

test('Python aliases and shell pattern commands stay in the measured set', () => {
  const result = buildPatternInventory(new Map([
    ['scripts/probe.py', 'import re as rx\npattern = rx.compile(r"^x+$")\n'],
    ['scripts/probe.sh', '# grep is only a comment\ngrep "^x" input\n'],
    ['scripts/empty.ts', 'export const value = 1;'],
  ]));

  expect(result.measured).toEqual(['scripts/empty.ts', 'scripts/probe.py', 'scripts/probe.sh']);
  expect(result.sites.map(site => site.kind)).toEqual(['python-regex', 'shell-pattern-command']);
});

test('a parser failure cannot produce an empty passing census', () => {
  expect(() => inventoryJavaScript('scripts/broken.ts', 'const =')).toThrow(Error);
  expect(() => buildPatternInventory(new Map([['scripts/broken.py', 'def broken(']]))).toThrow(Error);
  expect(inventoryJavaScript('scripts/valid.ts', 'const token = /x/;').map(site => site.kind))
    .toEqual(['regex-literal']);
});

test('an input outside the governed language set is refused', () => {
  expect(() => buildPatternInventory(new Map([['docs/example.md', '/text/']]))).toThrow(Error);
  expect(buildPatternInventory(new Map([['scripts/example.ts', 'export const value = 1;']])).measured)
    .toEqual(['scripts/example.ts']);
});

test('a candidate review belongs to its source bytes, not every parser in its file', () => {
  const file = 'packages/cf-backend/src/hooks/use-kinu.ts';
  const pattern = String.raw`/export\s+(.*)/`;
  const source = `const matcher = ${pattern};`;

  const review = { file, kind: 'regex-literal', owner: 'matcher',
    sourceSha256: createHash('sha256').update(pattern).digest('hex'), decision: 'framing' };

  const decisions = (code: string) => buildPatternInventory(new Map([[file, code]]), [review])
    .candidates.map(site => site.decision);

  expect(decisions(source)).toEqual(['framing']);
  expect(decisions(`${source}\nconst newParser = ${pattern};`)).toEqual(['framing', null]);
  expect(decisions(String.raw`const matcher = /import\s+(.*)/;`)).toEqual([null]);
});
