import { describe, expect, test } from 'bun:test';

import { findDrift } from './policy-drift';
import { readSources } from './sources';

const tree = (files: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(files));

const kinds = (files: Record<string, string>): string[] =>
  findDrift(tree(files)).drifts.map((d) => `${d.kind} ${d.key.slice(d.kind.length + 1)}`);

describe('policy drift — one name, two numbers', () => {
  test('the same name with different values is reported', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const RETRY_BASE_MS = 5_000;\nexport const a = RETRY_BASE_MS;\n',
      'packages/cf-backend/src/b.ts': 'const RETRY_BASE_MS = 30_000;\nexport const b = RETRY_BASE_MS;\n',
    })).toEqual(['divergent RETRY_BASE_MS']);
  });

  test('one home for the name is silent — the same edit, the other direction', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'export const RETRY_BASE_MS = 5_000;\n',
      'packages/cf-backend/src/b.ts': "import { RETRY_BASE_MS } from '@kinu.run/core';\nexport const b = RETRY_BASE_MS;\n",
    })).toEqual([]);
  });

  test('the same name and value in two packages is still two homes', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const CLEANUP_RETENTION_MS = 10 * 60 * 1000;\nexport const a = CLEANUP_RETENTION_MS;\n',
      'packages/cli/src/b.ts': 'const CLEANUP_RETENTION_MS = 600_000;\nexport const b = CLEANUP_RETENTION_MS;\n',
    })).toEqual(['duplicated CLEANUP_RETENTION_MS']);
  });

  test('the same name twice in one package is one home, not a divergence', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const LIMIT_MS = 5_000;\nexport const a = LIMIT_MS;\n',
      'packages/core/src/b.ts': 'const LIMIT_MS = 5_000;\nexport const b = LIMIT_MS;\n',
    })).toEqual([]);
  });
});

describe('policy drift — notation is not identity', () => {
  test('300_000 and 5 * 60 * 1000 are one number', () => {
    // Written as text these are two unrelated constants, which is why a grep
    // for the value finds one of them and a reader concludes there is one.
    expect(kinds({
      'packages/core/src/a.ts': 'const STALL_WINDOW_MS = 300_000;\nexport const a = STALL_WINDOW_MS;\n',
      'packages/cf-backend/src/b.ts': 'const STALL_WINDOW_MS = 5 * 60 * 1000;\nexport const b = STALL_WINDOW_MS;\n',
    })).toEqual(['duplicated STALL_WINDOW_MS']);
  });

  test('a value that only arithmetic reveals as different is still a divergence', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const GRACE_MS = 5 * 60 * 1000;\nexport const a = GRACE_MS;\n',
      'packages/cf-backend/src/b.ts': 'const GRACE_MS = 5 * 60 * 100;\nexport const b = GRACE_MS;\n',
    })).toEqual(['divergent GRACE_MS']);
  });
});

describe('policy drift — two names for one policy', () => {
  test('one number and one discriminating word in two packages is an alias', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const MAX_DELIVERY_ATTEMPTS = 8;\nexport const a = MAX_DELIVERY_ATTEMPTS;\n',
      'packages/cf-backend/src/b.ts': 'const MAX_SEND_ATTEMPTS = 8;\nexport const b = MAX_SEND_ATTEMPTS;\n',
    })).toEqual(['aliased MAX_SEND_ATTEMPTS@packages/cf-backend/src/b.ts = MAX_DELIVERY_ATTEMPTS@packages/core/src/a.ts']);
  });

  test('a crowd at one word and value is a common default, not a shared policy', () => {
    // The measured failure this rule exists for: `TIMEOUT` is carried by
    // seventeen names here and 30s is what everyone picks, so a third carrier
    // is evidence AGAINST these being one decision.
    expect(kinds({
      'packages/core/src/a.ts': 'const CLONE_TIMEOUT_MS = 30_000;\nexport const a = CLONE_TIMEOUT_MS;\n',
      'packages/cf-backend/src/b.ts': 'const SSE_TIMEOUT_MS = 30_000;\nexport const b = SSE_TIMEOUT_MS;\n',
      'packages/cli/src/c.ts': 'const GIT_TIMEOUT_MS = 30_000;\nexport const c = GIT_TIMEOUT_MS;\n',
    })).toEqual([]);
  });

  test('a shared UNIT relates nothing — MS is in every policy name there is', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const DEPLOY_TIMEOUT_MS = 600_000;\nexport const a = DEPLOY_TIMEOUT_MS;\n',
      'packages/cf-backend/src/b.ts': 'const AUTH_TTL_MS = 600_000;\nexport const b = AUTH_TTL_MS;\n',
    })).toEqual([]);
  });

  test('a shared QUALIFIER relates nothing either', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const MAX_FOO_BYTES = 4096;\nexport const a = MAX_FOO_BYTES;\n',
      'packages/cf-backend/src/b.ts': 'const MAX_BAR_BYTES = 4096;\nexport const b = MAX_BAR_BYTES;\n',
    })).toEqual([]);
  });
});

describe('policy drift — the calibration true negative', () => {
  /* `CLOUD_MAX_INLINE_ATTACHMENT_BYTES` (1 MiB, core) and
     `LOCAL_MAX_INLINE_ATTACHMENT_BYTES` (8 MiB, cli-backend) are deliberately
     8x apart. They are the hardest case in the tree because every cheap signal
     says duplication: same role words, same shape, adjacent concepts. What
     makes them correct is that core's declaration NAMES its twin, which is the
     third signal and the one a reader can act on. */
  const CLOUD = `
// The name carries the backend because the cap does: a local session is bounded
// by its own constraint, LOCAL_MAX_INLINE_ATTACHMENT_BYTES in cli-backend.
const CLOUD_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;
export const a = CLOUD_MAX_INLINE_ATTACHMENT_BYTES;
`;
  const LOCAL = 'const LOCAL_MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;\nexport const b = LOCAL_MAX_INLINE_ATTACHMENT_BYTES;\n';

  test('the real pair is silent', () => {
    expect(kinds({
      'packages/core/src/cloud-wire.ts': CLOUD,
      'packages/cli-backend/src/local-session.ts': LOCAL,
    })).toEqual([]);
  });

  test('the real pair is silent in the tree as it stands', () => {
    const drifts = findDrift(readSources()).drifts;
    expect(drifts.filter((d) => d.key.includes('ATTACHMENT'))).toEqual([]);
  // Measured 3.5 s on a box at load 66-98 (2026-09-02 sweep, foreign mutation jobs on all
  // 24 threads), where bun's default 5 s bound read red and the test is green alone. A bound
  // on a finite run, stated with its measurement, not a detector.
  }, 15_000);

  test('and the exculpating signal is load-bearing: same values, no reference, reported', () => {
    // Same two declarations at the SAME value with the cross-reference comment
    // removed. If this passed, the true negative above would be an accident of
    // the values rather than a judgement about the evidence.
    expect(kinds({
      'packages/core/src/cloud-wire.ts': 'const CLOUD_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;\nexport const a = CLOUD_MAX_INLINE_ATTACHMENT_BYTES;\n',
      'packages/cli-backend/src/local-session.ts': 'const LOCAL_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;\nexport const b = LOCAL_MAX_INLINE_ATTACHMENT_BYTES;\n',
    }).length).toBeGreaterThan(0);
  });

  test('naming the counterpart anywhere in either file silences it', () => {
    expect(kinds({
      'packages/core/src/cloud-wire.ts': '// see LOCAL_MAX_INLINE_ATTACHMENT_BYTES\nconst CLOUD_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;\nexport const a = CLOUD_MAX_INLINE_ATTACHMENT_BYTES;\n',
      'packages/cli-backend/src/local-session.ts': 'const LOCAL_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;\nexport const b = LOCAL_MAX_INLINE_ATTACHMENT_BYTES;\n',
    })).toEqual([]);
  });
});

describe('policy drift — inline literals', () => {
  test('a bare literal whose role IS a named policy is reported', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const CACHE_TTL_MS = 60_000;\nexport const a = CACHE_TTL_MS;\n',
      'packages/cf-backend/src/b.ts': 'export const options = { cacheTtlMs: 60 * 1000 };\n',
    })).toEqual(['unnamed packages/cf-backend/src/b.ts:cacheTtlMs=60000']);
  });

  test('importing the constant instead silences it', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'export const CACHE_TTL_MS = 60_000;\n',
      'packages/cf-backend/src/b.ts': "import { CACHE_TTL_MS } from '@kinu.run/core';\nexport const options = { cacheTtlMs: CACHE_TTL_MS };\n",
    })).toEqual([]);
  });

  test('a partial role match is not a match', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const MCP_CALL_TIMEOUT_MS = 30_000;\nexport const a = MCP_CALL_TIMEOUT_MS;\n',
      'packages/cf-backend/src/b.ts': 'export const go = () => setTimeout(() => {}, 30_000);\n',
    })).toEqual([]);
  });

  test('a number in no role position is not a policy', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const CACHE_TTL_MS = 60_000;\nexport const a = CACHE_TTL_MS;\n',
      'packages/cf-backend/src/b.ts': 'export const b = [1, 2, 3][60_000 % 3];\n',
    })).toEqual([]);
  });
});

describe('policy drift — the denominators it claims', () => {
  test('the real tree is scanned, and every denominator is non-zero', () => {
    const survey = findDrift(readSources());
    expect(survey.files).toBeGreaterThan(500);
    expect(survey.declared.length).toBeGreaterThan(200);
    expect(survey.inline.length).toBeGreaterThan(1000);
  });

  test('a lowercase constant is out of scope, and the scope says so', () => {
    expect(kinds({
      'packages/core/src/a.ts': 'const retryBaseMs = 5_000;\nexport const a = retryBaseMs;\n',
      'packages/cf-backend/src/b.ts': 'const retryBaseMs = 30_000;\nexport const b = retryBaseMs;\n',
    })).toEqual([]);
  });
});
