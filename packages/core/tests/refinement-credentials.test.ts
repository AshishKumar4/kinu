/**
 * Refinement of `Safety/Credentials.lean — openStored` by the deployed envelope: each row in
 * `lean/fixtures/credential-envelope.json` is sealed by one deployment's `createCredentialCipher`
 * (real AES-GCM) and opened by another's, and the open must answer what the model answers: the
 * plaintext, or a refusal naming a missing key, a context the envelope was not sealed for, or a row
 * that holds no envelope.
 * `bash scripts/verify-lean.sh` regenerates the fixture from the model.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { createCredentialCipher } from '../src/credentials/envelope';

const FIXTURE = resolve(import.meta.dir, '../../../lean/fixtures/credential-envelope.json');

const FixtureSchema = v.object({
  fixture: v.literal('credential-envelope'),
  cases: v.array(v.object({
    plain: v.boolean(),
    sealKey: v.string(),
    sealAad: v.string(),
    plaintext: v.string(),
    openKeys: v.tupleWithRest([v.string()], v.string()),
    openAad: v.string(),
    outcome: v.union([
      v.object({ opens: v.string() }),
      v.object({ refused: v.picklist(['no-key', 'mismatch', 'not-sealed']) }),
    ]),
  })),
});

const { cases } = v.parse(FixtureSchema, JSON.parse(readFileSync(FIXTURE, 'utf8')));

/** The model names keys; a deployment holds secrets of at least 32 characters. */
function secret(name: string): string {
  return `fixture-secret-${name}`.padEnd(40, '0');
}

describe('createCredentialCipher refines Credentials.openStored', () => {
  test('the fixture opens, and refuses a missing key, a foreign context and an unsealed row', () => {
    const outcomes = new Set(cases.map((c) => ('opens' in c.outcome ? 'opens' : c.outcome.refused)));
    expect(outcomes).toEqual(new Set(['opens', 'no-key', 'mismatch', 'not-sealed']));
  });

  test.each(cases.map((c, i) => [i, c] as const))('case %d', async (_i, c) => {
    const sealer = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: secret(c.sealKey) });
    const stored = c.plain ? c.plaintext : await sealer.seal(c.sealAad, c.plaintext);
    const [current, ...retired] = c.openKeys;

    const opener = await createCredentialCipher({
      CREDENTIAL_ENCRYPTION_KEY: secret(current),
      CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: retired.map(secret).join(','),
    });

    const opened = opener.open(c.openAad, stored);

    if ('opens' in c.outcome) {
      expect(await opened).toBe(c.outcome.opens);
    } else if (c.outcome.refused === 'no-key') {
      await expect(opened).rejects.toThrow('which this deployment no longer has');
    } else if (c.outcome.refused === 'not-sealed') {
      await expect(opened).rejects.toThrow('is not a sealed envelope');
    } else {
      await expect(opened).rejects.toThrow('failed to decrypt');
    }
  });
});
