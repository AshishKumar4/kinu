// The secret scan's own gate. Its failure mode was silent: the ignore file was
// never read, so every "false positive" instruction in the error message was
// wrong, and one pattern quietly skipped every test file. Both are properties
// of the pure functions below, so both are now asserted.
//
// Every fixture is CONCATENATED rather than written out. This file is scanned
// by the very patterns it exercises, so a literal fixture here would be a
// finding — and the alternatives (ignore entries for each, or exempting this
// file) are the two holes the rewrite exists to close. Splitting the literal
// keeps the string identical at runtime and absent from the source.
import { describe, test, expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_HISTORY_BLOB_BYTES,
  PATTERNS,
  REMOVED_CREDENTIAL_BLOB,
  adjudicateHistory,
  applyIgnores,
  enumerateHistoricalReachability,
  parseIgnoreFile,
  scanHistory,
  scanText,
  suppresses,
} from './secret-scan';
import { isTextSource, trackedFiles } from './sources';
import { git, initRepo, scratchDir } from '@kinu.run/test-utils';

const REPO_ROOT = join(import.meta.dir, '..');

const AWS_KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const OTHER_AWS_KEY = `AKIA${'ZZZZZZZZZZZZZZZZ'}`;
const UNRELATED_AWS_KEY = `AKIA${'QQQQQQQQQQQQQQQQ'}`;
const PRIVATE_KEY = `-----BEGIN RSA ${'PRIVATE KEY'}-----`;
const BARE_PRIVATE_KEY = `-----BEGIN ${'PRIVATE KEY'}-----`;
const JWT = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9${'.'}eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkoifQ.sig`;
const BEARER = `headers: { 'cf-aig-authorization': 'Bearer ${'abcdefghijklmnopqrstuvwxyz012345'}' }`;
const ASSIGNMENT = `const api_key = ${'"sk-live-abc12345"'};`;
// Joined, not interpolated: an interpolation with no space or '@' in it still
// satisfies [^@\s]{8,}, so the shape survived a template literal.
const CONN_URL = ['postgres://admin', 'hunter2hunter2@db.example.com/app'].join(':');
const TYPE_DECL = `interface Creds { api_key: ${'"literal-union-value"'} }`;

describe('the patterns catch what they are for', () => {
  const cases: Array<[string, string]> = [
    ['aws-access-key', `const k = "${AWS_KEY}";`],
    ['private-key', PRIVATE_KEY],
    ['private-key', BARE_PRIVATE_KEY],
    ['jwt', `const t = "${JWT}";`],
    ['aig-bearer', BEARER],
    ['secret-assignment', ASSIGNMENT],
    ['credentialed-url', CONN_URL],
  ];

  for (const [id, line] of cases) {
    test(`${id} matches: ${line.slice(0, 40)}`, () => {
      expect(scanText('f.ts', line).map((f) => f.pattern)).toContain(id);
    });
  }

  // The blanket '.test.' skip this replaces would have passed all of these.
  test('a secret in a test file is still a finding — no file class is exempt', () => {
    for (const [id, line] of cases) {
      expect(scanText('packages/x/tests/thing.test.ts', line).map((f) => f.pattern)).toContain(id);
    }
  });

  // The fragment decision, recorded in the rule comment: 8+ hex after the
  // prefix is a finding even without the full `pta_<32 hex>_<43>` shape — a
  // truncated paste is still evidence a live token reached a durable file. The
  // 2026-08-18 transcript leak carried a fragment of exactly this shape, and the
  // old rule missed it twice over: a `{16,}` floor, and a benign that exempted
  // any LINE containing `…`. The fragment below is synthetic — the real one is a
  // live credential, and it does not belong in a tracked file, least of all in
  // the suite proving the scanner that catches it.
  test('a truncated token fragment is a finding, ellipsis and all', () => {
    const fragment = ['pta', '0123456789abcdef'].join('_');
    expect(scanText('f.md', `KINU_TOKEN=${fragment}\u2026 kinu exec`).map((f) => f.pattern))
      .toEqual(['kinu-token']);
  });

  test('prose that only NAMES the token shape stays benign', () => {
    for (const line of ['use pta_\u2026 from setup', 'use ptc_... from setup', 'set <your-pta-token>']) {
      expect(scanText('f.md', line)).toEqual([]);
    }
  });

  test('benign shapes do not fire', () => {
    const benign = [
      `const key = process.env.API_KEY; // api_key = ${"'from-the-env'"}`,
      `password: ${'"<your-password-here>"'}`,
      `redis://user:${'password'}@localhost:6379`,
      TYPE_DECL,
    ];
    for (const line of benign) expect(scanText('f.ts', line)).toEqual([]);
  });

  test('reports every match on a line, with its line number', () => {
    const found = scanText('f.ts', `ok\n${AWS_KEY} and ${OTHER_AWS_KEY}\n`);
    expect(found).toHaveLength(2);
    for (const f of found) expect(f.line).toBe(2);
  });

  test('patterns are global — a stateful lastIndex would skip alternate matches', () => {
    for (const p of PATTERNS) expect(p.regex.flags).toContain('g');
  });
});

describe('parseIgnoreFile', () => {
  test('reads path + literal, skipping blanks and comments', () => {
    expect(parseIgnoreFile('# note\n\n  a/b.ts  SOME-LITERAL  \n')).toEqual([
      { path: 'a/b.ts', literal: 'SOME-LITERAL', line: 3 },
    ]);
  });

  test('keeps a literal that contains spaces', () => {
    const literal = `password = ${'"actual-value"'}`;
    expect(parseIgnoreFile(`a/b.ts ${literal}`)[0]!.literal).toBe(literal);
  });

  // The old format. It parsed as "ignore this file" and suppressed nothing.
  test('refuses a bare path rather than accepting it as a no-op', () => {
    expect(() => parseIgnoreFile('.env.example\n')).toThrow(/expected "<path> <literal>"/);
  });
});

describe('suppression is exact', () => {
  const entry = { path: 'a/b.ts', literal: AWS_KEY, line: 1 };
  const finding = (over: Partial<{ file: string; match: string }> = {}) => ({
    pattern: 'aws-access-key', file: 'a/b.ts', line: 9,
    match: AWS_KEY, text: 'x', ...over,
  });

  test('suppresses only its own file and its own literal', () => {
    expect(suppresses(entry, finding())).toBe(true);
    expect(suppresses(entry, finding({ file: 'other/b.ts' }))).toBe(false);
    expect(suppresses(entry, finding({ match: UNRELATED_AWS_KEY }))).toBe(false);
  });

  test('survives the fixture moving lines, since it names no line', () => {
    expect(suppresses(entry, finding())).toBe(true);
    expect(suppresses(entry, { ...finding(), line: 4210 })).toBe(true);
  });

  test('a stale entry is reported, not silently tolerated', () => {
    const stale = { path: 'gone.ts', literal: AWS_KEY, line: 2 };
    const out = applyIgnores([finding()], [entry, stale]);
    expect(out.findings).toEqual([]);
    expect(out.unused).toEqual([stale]);
  });
});

// The bug this whole file exists for: the shipped ignore file must actually
// suppress the shipped fixture. Reading both is the only way to know.
test('the committed .secretscanignore suppresses the redactor fixture it names', () => {
  const entries = parseIgnoreFile(readFileSync(join(REPO_ROOT, '.secretscanignore'), 'utf8'));
  expect(entries.length).toBeGreaterThan(0);
  const fixture = 'packages/cli/tests/debug.test.ts';
  const raw = scanText(fixture, readFileSync(join(REPO_ROOT, fixture), 'utf8'));
  expect(raw.map((f) => f.pattern)).toContain('aws-access-key');
  expect(applyIgnores(raw, entries).findings).toEqual([]);
});

// This file is tracked, so the scan reads it. If a fixture above were ever
// written as a literal, this fails — and the failure names the line.
test('this file contains no literal secret shape of its own', () => {
  const self = readFileSync(join(REPO_ROOT, 'scripts', 'secret-scan.test.ts'), 'utf8');
  expect(scanText('scripts/secret-scan.test.ts', self)).toEqual([]);
});

test('the scanned set is the enumerated set narrowed by content type, nothing else', () => {
  // Presence-on-disk filtering lives in the enumerator and narrows only
  // UNTRACKED additions — a tracked file is in the corpus even with no
  // working-tree copy, read from its index blob (`scripts/sources.test.ts`
  // proves both). What is left here is the one narrowing this gate owns: which
  // extensions a human writes text into. Both halves are asserted, because a
  // predicate that admitted everything and one that admitted nothing look
  // identical downstream.
  expect(['src/current.ts', 'docs/current.md', 'infra/main.tf.json', 'id_rsa.pem', 'a.sh']
    .filter(isTextSource))
    .toEqual(['src/current.ts', 'docs/current.md', 'infra/main.tf.json', 'id_rsa.pem', 'a.sh']);
  expect(['dist/ignored.bin', 'ui/logo.png', 'notes', 'Makefile'].filter(isTextSource)).toEqual([]);

  // The corpus this gate actually runs on: every file the enumerator lists that
  // holds human-written text, and it must not be empty — an enumeration that
  // fails quietly reports a clean tree, which is what a secret scan being green
  // would then mean.
  const scanned = trackedFiles().filter(isTextSource);
  expect(scanned.length).toBeGreaterThan(500);
  expect(scanned).toContain('scripts/secret-scan.test.ts');
});

function historyFixture() {
  const repo = scratchDir('secret-history');
  initRepo(repo);
  writeFileSync(join(repo, 'README.md'), 'clean\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'clean base');
  const primary = git(repo, 'branch', '--show-current').trim();

  // The credential exists only on a non-current local branch. A scanner that
  // reads HEAD or the working tree alone is green; every local ref is red.
  git(repo, 'checkout', '-qb', 'history-fixture');
  const secret = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
  writeFileSync(join(repo, 'history.md'), `key=${secret}\n`);
  writeFileSync(join(repo, 'binary.bin'), Buffer.from([0x6b, 0, 0x69]));
  writeFileSync(join(repo, 'oversize.txt'), Buffer.alloc(MAX_HISTORY_BLOB_BYTES + 1, 0x78));
  git(repo, 'add', 'history.md', 'binary.bin', 'oversize.txt');
  git(repo, 'commit', '-qm', 'historical fixture');
  const oid = git(repo, 'rev-parse', 'HEAD:history.md').trim();
  git(repo, 'checkout', '-q', primary);
  return { repo, oid, secret };
}

describe('reachable history', () => {
  test('a historical credential is red until its exact blob/path/detector/count adjudication is present', async () => {
    const fixture = historyFixture();
    const expected = {
      detector: 'aws-access-key',
      oid: fixture.oid,
      path: 'history.md',
      refClass: 'branch' as const,
      count: 1,
    };

    const red = await scanHistory({ repoRoot: fixture.repo, adjudications: [] });
    expect(red.findings).toEqual([expected]);
    expect(Object.keys(red.findings[0]!).sort()).toEqual(['count', 'detector', 'oid', 'path', 'refClass']);
    expect(JSON.stringify(red)).not.toContain(fixture.secret);
    expect(red.stats.refs).toBe(2);
    expect(red.stats.objects).toBeGreaterThan(0);
    expect(red.stats.blobs).toBeGreaterThanOrEqual(4);
    expect(red.stats.nul).toBe(1);
    expect(red.stats.oversize).toBe(1);
    expect(red.stats.scanned).toBeGreaterThan(0);

    const exact = await scanHistory({ repoRoot: fixture.repo, adjudications: [expected] });
    expect(exact.findings).toEqual([]);
    expect(exact.adjudicated).toBe(1);

    // None of the tuple's four durable properties is a path-wide or test-wide
    // exception. A near miss re-arms the historical finding.
    for (const nearMiss of [
      { ...expected, oid: '0'.repeat(40) },
      { ...expected, path: 'other.md' },
      { ...expected, detector: 'jwt' },
      { ...expected, count: 2 },
    ]) {
      expect(adjudicateHistory([expected], [nearMiss]).findings).toEqual([expected]);
    }
  });

  test('the known removed credential blob is absent from local-ref reachability', () => {
    const reachability = enumerateHistoricalReachability();
    expect(reachability.objects.some((object) => object.oid === REMOVED_CREDENTIAL_BLOB)).toBe(false);
  });

  test('the checked-in history has only its reviewed exact adjudications', async () => {
    const result = await scanHistory();
    expect(result.findings).toEqual([]);
    expect(result.adjudicated).toBeGreaterThan(0);
    expect(result.stats.objects).toBeGreaterThan(0);
  }, 30_000);
});

test('the current scanner source has no detector-shaped literal of its own', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'secret-scan.ts'), 'utf8');
  expect(scanText('scripts/secret-scan.ts', source)).toEqual([]);
});
