// The verified secret scan reads TruffleHog's JSON lines: a verified result is red and names where it sits, never the
// credential; a scan that did not finish is no summary, so no verdict.
import { expect, test } from 'bun:test';
import { findingsOf, summaryOf, verdictOf } from './verified-secret-scan';

// Assembled, so the file holds no credential shape for the pattern scan to find.
const CREDENTIAL = ['ghp', '_', '0123456789abcdefghijklmnopqrstuvwxyzAB'].join('');

const result = (verified: boolean, line?: number): string => JSON.stringify({
  DetectorName: 'Github',
  Verified: verified,
  Raw: CREDENTIAL,
  RawV2: CREDENTIAL,
  Redacted: CREDENTIAL.slice(0, 8),
  SourceMetadata: { Data: { Git: { commit: '6ca74f1409f4d1fd31d7c2a1e0d8bbf1fd3f5b40', file: 'notes/setup.md', email: 'a@b.c', ...(line !== undefined && { line }) } } },
});

const summary = JSON.stringify({
  level: 'info-0', logger: 'trufflehog', msg: 'finished scanning', chunks: 597947, bytes: 644443577,
  verified_secrets: 1, unverified_secrets: 0, trufflehog_version: '3.97.1',
});

test('a verified credential is red, named by detector, file, line and commit, and its value is printed nowhere', () => {
  const stdout = [result(true, 12), result(false, 3), 'not json'].join('\n');
  const parsed = summaryOf(`{"level":"info-0","msg":"running source"}\n${summary}\n`);

  expect(parsed).toBeDefined();
  const verdict = verdictOf(findingsOf(stdout), parsed ?? unreachable());

  expect({ code: verdict.code, printed: verdict.lines.join('\n').includes(CREDENTIAL.slice(4)) }).toEqual({ code: 1, printed: false });
  expect(findingsOf(stdout)).toEqual([{ detector: 'Github', commit: '6ca74f1409f4d1fd31d7c2a1e0d8bbf1fd3f5b40', at: 'notes/setup.md:12' }]);
});

test('no verified credential is green and says what it scanned', () => {
  const verdict = verdictOf(findingsOf(result(false)), summaryOf(summary) ?? unreachable());

  expect(verdict).toEqual({ code: 0, lines: ['verified-secret-scan: ok — no verified credential in 597947 chunks, 644443577 bytes of every ref the clone holds, TruffleHog 3.97.1'] });
});

test('a scan that never logged its summary has none', () => {
  expect(summaryOf('{"level":"info-0","msg":"running source"}\n{"level":"error","msg":"scanning repo failed"}')).toBeUndefined();
});

function unreachable(): never {
  return expect.unreachable('the summary parsed');
}
