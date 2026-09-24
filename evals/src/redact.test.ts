import { describe, expect, test } from 'bun:test';
import { heldSecrets, redact, redactJson } from './redact';

// Built from parts, as the repo's other redaction fixtures are, so no secret-shaped literal sits in the tree.
const BASE64_SECRET = ['q7Lr+ZkX/9vT2mWp', '8sHc4Nd6Ye1Uf0Ab', '3Gi5Jo7Kl+Q='].join('');

const SHORT_SECRET = ['s3cr', 'et-v', 'alue'].join('');

describe('redact', () => {
  test('scrubs the formats a secret usually has', () => {
    const syntheticKey = ['sk', 'live', '0123456789abcdef'].join('_');
    const text = `GET https://preview-0000000000-fixture.kinu.run/ Bearer abc.def-123 ${syntheticKey}`;

    expect(redact(text, [])).toBe('GET https://<preview>.kinu.run/ Bearer <redacted> <token>');
  });

  test('a base64 secret is one run, though + / and = split it into words shorter than any other rule matches', () => {
    expect(redact(`the key was ${BASE64_SECRET}, rejected`, [])).toBe('the key was <base64>, rejected');
    // Paths and prose share the alphabet but not the mix of cases and digits.
    expect(redact('home/user/slates/library/reports/overdue/march', [])).toBe('home/user/slates/library/reports/overdue/march');
  });

  test('the identity header echoed by a tool error loses its value, whatever the value looks like', () => {
    expect(redact('sent x-kinu-dev-identity-secret: abc123 and "x-kinu-dev-identity-secret":"zz9"', []))
      .toBe('sent x-kinu-dev-identity-secret: <secret> and "x-kinu-dev-identity-secret":"<secret>"');
  });

  test('the held credential is scrubbed by value, as written, inside a URL and inside JSON', () => {
    const held = heldSecrets({ KINU_EVAL_WEB_IDENTITY: SHORT_SECRET });
    const inUrl = `https://kinu.run/api?identity=${encodeURIComponent(SHORT_SECRET)}`;

    expect(redact(`echoed ${SHORT_SECRET} back`, held)).toBe('echoed <secret> back');
    expect(redact(inUrl, held)).toBe('https://kinu.run/api?identity=<secret>');
    expect(redactJson({ header: SHORT_SECRET, rows: [`at ${SHORT_SECRET}`] }, held)).toEqual({ header: '<secret>', rows: ['at <secret>'] });
    expect(redact(`${encodeURIComponent(BASE64_SECRET)}`, heldSecrets({ KINU_EVAL_WEB_IDENTITY: BASE64_SECRET }))).toBe('<secret>');
  });

  test('no credential held, or one too short to be one, scrubs nothing by value', () => {
    expect(heldSecrets({})).toEqual([]);
    expect(heldSecrets({ KINU_EVAL_WEB_IDENTITY: 'abc' })).toEqual([]);
  });
});
