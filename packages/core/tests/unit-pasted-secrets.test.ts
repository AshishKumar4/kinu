// A secret in a chat draft or a pasted `.env` is found with the name and hosts to offer it under; prose, placeholders and
// the vault's own stand-ins are not. Values are assembled at runtime, so this source matches no detector.
import { describe, expect, test } from 'bun:test';
import { parseDotenv, pastedSecrets } from '../src/index';

const GITHUB = ['ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

const OPENAI = ['sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz012345'].join('');

const DATABASE_URL = ['postgres', '://app:', 'hunter22secret', '@db.example.net/app'].join('');

/** A JWT whole, signature included: three base64url segments. */
const JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkYSJ9', 'c2lnbmF0dXJlLXBhcnQtb2YtdGhlLXRva2Vu'].join('.');

/** A Kinu CLI token: its user's id, then a base64url secret that is not hex. */
const KINU_TOKEN = ['ptc_', '0123456789abcdef0123456789abcdef', '_', 'Zq-9_mXvL2pRtYw8NbKcHd4FgJs7UeA1oIiE3rTyUwQ'].join('');

describe('a pasted .env', () => {
  test('reads as dotenv does: export, quotes and comments', () => {
    expect(parseDotenv([
      '# keys for staging',
      `export GITHUB_TOKEN="${GITHUB}"`,
      "DATABASE_PASSWORD='p@ss word'",
      'PORT=8080 # the server',
      `API_KEY="${OPENAI}" # staging`,
      "HASHED='a#b' # a comment after a quoted value with a # in it",
      'EMPTY=',
      'not a line',
    ].join('\n'))).toEqual([
      { name: 'GITHUB_TOKEN', value: GITHUB },
      { name: 'DATABASE_PASSWORD', value: 'p@ss word' },
      { name: 'PORT', value: '8080' },
      { name: 'API_KEY', value: OPENAI },
      { name: 'HASHED', value: 'a#b' },
    ]);
  });
});

describe('a pasted .env whose value dotenv reads past what a line shows', () => {
  test('a quote a backslash escapes does not end the value, and a quoted value may run across lines', () => {
    const tail = `${OPENAI}-tail`;

    expect(parseDotenv([
      `API_KEY="say \\"${tail}\\""`,
      `CERT="-----line one`,
      `line two-----" # the cert`,
      'PORT=8080',
    ].join('\n'))).toEqual([
      { name: 'API_KEY', value: `say \\"${tail}\\"` },
      { name: 'CERT', value: '-----line one\nline two-----' },
      { name: 'PORT', value: '8080' },
    ]);
  });
});

describe('a secret in a chat draft', () => {
  test("a provider's token in prose is offered under its SDKs' own variable, with the hosts its API answers on", () => {
    expect(pastedSecrets(`here is my token ${GITHUB} please push the branch`)).toEqual([
      { value: GITHUB, name: 'GITHUB_TOKEN', hosts: ['api.github.com', 'github.com'], provider: 'GitHub', position: { kind: 'authorization' } },
    ]);
  });

  test("an assignment keeps the owner's name; a secret-named one counts even with no known shape, a plain setting does not", () => {
    const found = pastedSecrets(['OPENAI_API_KEY=' + OPENAI, 'STRIPE_WEBHOOK_SECRET=whsec_local_value', 'PORT=8080', `DATABASE_URL=${DATABASE_URL}`].join('\n'));

    expect(found.map(({ name, provider }) => [name, provider])).toEqual([
      ['OPENAI_API_KEY', 'OpenAI'], ['STRIPE_WEBHOOK_SECRET', null], ['DATABASE_URL', null],
    ]);
  });

  test('a JWT and a Kinu token in prose are lifted whole, so moving one leaves none of it in the message', () => {
    const found = pastedSecrets(`use ${JWT} and ${KINU_TOKEN} for the call`);

    expect(found.map(({ value }) => value).sort()).toEqual([JWT, KINU_TOKEN].sort());
  });

  test("a provider whose API reads its key elsewhere is offered with that position", () => {
    const google = ['AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'].join('');

    expect(pastedSecrets(`the maps key is ${google}`)[0]?.position).toEqual({ kind: 'query', name: 'key' });
  });

  test('two of one kind get distinct names, and a private key block is one secret', () => {
    const second = GITHUB.replace('A1b2', 'Z9y8');
    const key = ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----'].join('');

    expect(pastedSecrets(`${GITHUB} and ${second}\n${key}`).map(({ name }) => name)).toEqual(['PRIVATE_KEY', 'GITHUB_TOKEN', 'GITHUB_TOKEN_2']);
  });

  test('prose, a placeholder for the reader to fill, and a vault stand-in are not secrets', () => {
    expect(pastedSecrets('set API_KEY=<your-key> in the dashboard, then use $GITHUB_TOKEN')).toEqual([]);
    expect(pastedSecrets(`TOKEN=pxs1_${'a'.repeat(43)}`)).toEqual([]);
    expect(pastedSecrets('the build passed and the deploy is green')).toEqual([]);
  });
});
