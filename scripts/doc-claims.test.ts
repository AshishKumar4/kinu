import { describe, expect, test } from 'bun:test';
import { auditClaims, isClaimSource } from './doc-claims';
import { isDocument, isParseable, readMatching, trackedFiles } from './sources';

const target = ['packages', 'core', 'src', 'existing.ts'].join('/');
const gone = ['packages', 'core', 'src', 'gone.ts'].join('/');
const paths = new Set([target]);
const source = 'scripts/fixture.ts';

function kinds(text: string): string[] {
  return auditClaims(source, text, paths).findings.map(finding => finding.kind);
}

describe('comment path references', () => {
  test('a removed target fails for line and block comments', () => {
    for (const wrap of [(path: string) => `// See ${path}`, (path: string) => `/** See \`${path}\`. */`]) {
      expect(kinds(wrap(gone))).toEqual(['missing-path']);
      expect(kinds(wrap(target))).toEqual([]);
    }
  });

  test('a string that looks like a comment does not cite a file', () => {
    expect(kinds(`const message = ${JSON.stringify(`// See ${gone}`)};`)).toEqual([]);
  });

  test('external paths and machine-local research remain outside resolution', () => {
    for (const path of [`https://example.com/${gone}`, `~/other/${gone}`, 'docs/research/private.md', 'node_modules/private/index.js', 'lean/Kinu/Example.lean']) {
      expect(kinds(`// See ${path}`)).toEqual([]);
    }
  });

  test('abbreviations must identify one target', () => {
    const abbreviated = ['tools', 'named.ts'].join('/');
    const text = `// See ${abbreviated}`;
    expect(auditClaims(source, text, new Set([`packages/core/src/${abbreviated}`])).findings).toEqual([]);
    expect(auditClaims(source, text, new Set([`packages/core/src/${abbreviated}`, `packages/cli/src/${abbreviated}`])).findings.map(finding => finding.kind)).toEqual(['missing-path']);
  });
});

describe('absolute behaviour claim shape', () => {
  test('an unbounded claim fails in a document and a comment', () => {
    const claim = '`writeFile` always persists data.';
    expect(auditClaims('docs/fixture.md', claim, paths).findings.map(finding => finding.kind)).toEqual(['unbounded-claim']);
    expect(kinds(`/** ${claim} */`)).toEqual(['unbounded-claim']);
    expect(kinds('/** `writeFile` always persists data when commit succeeds. */')).toEqual([]);
    expect(kinds(`/** \`writeFile\` always persists data (${target}). */`)).toEqual([]);
  });

  test('a qualifier in another sentence cannot bound a claim', () => {
    expect(kinds('/** `writeFile` always persists data. When commit fails, report the error. */')).toEqual(['unbounded-claim']);
  });

  test('an instruction is not a behaviour claim', () => {
    expect(kinds('/** Never call `writeFile` without consent. */')).toEqual([]);
  });
  test('a retired subject cannot claim current behaviour', () => {
    expect(kinds('/** The removed `oldStep` always runs when requested. */')).toEqual(['retired-behaviour']);
    expect(kinds('/** The removed `oldStep` ran when requested. */')).toEqual([]);
  });

  test('qualifiers survive comment wrapping and named locators', () => {
    expect(kinds('// `writeFile` always persists data\n// because commit completed.')).toEqual([]);
    expect(kinds('/** `writeFile` always persists data (`writer.ts:12`). */')).toEqual([]);
    expect(kinds('/** `writeFile` always persists data; see {@link durableCommit}. */')).toEqual([]);
  });
});

test('the measured corpus equals the governed corpus in both directions', () => {
  const governed = trackedFiles().filter(file => isDocument(file) || isParseable(file)).sort();
  expect([...readMatching(isClaimSource).keys()].sort()).toEqual(governed);
  expect(governed).toContain('scripts/doc-claims.test.ts');
  expect(isClaimSource('packages/new/src/new.ts')).toBe(true);
  expect(isClaimSource('docs/new.md')).toBe(true);
  expect(isClaimSource('data/image.png')).toBe(false);
});
