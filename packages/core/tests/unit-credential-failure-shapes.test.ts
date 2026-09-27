/**
 * The migration keeps what a caller sees: classified failures retain their cause and synchronous or asynchronous delivery.
 */
import { describe, expect, test } from 'bun:test';
import { createCredentialCipher } from '../src/credentials/envelope';
import { credentialToHeaders } from '../src/credentials/headers';
import { fileRestorePlan } from '../src/checkpoints/types';
import { KinuError } from '../src/obs/error';

const KEY = 'a-credential-encryption-key-for-this-test-0001';

const RETIRED = 'a-retired-credential-encryption-key-000000002';

/** How a call failed: the thrown value, as a caller's `catch` receives it. */
interface Failed {
  readonly thrown: Error | KinuError | null;
}

const failedWith = (error: Error): Failed => ({ thrown: error });

function expectClassified(failed: Failed, code: 'bad_input' | 'unavailable' | 'unsupported'): void {
  expect(failed.thrown).toBeInstanceOf(Error);
  expect(failed.thrown).toBeInstanceOf(KinuError);
  expect(failed.thrown).toMatchObject({ code });
}

async function rejection(run: () => Promise<object | string>): Promise<Failed> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return failedWith(error);
  }

  return { thrown: null };
}

function thrownBy(run: () => void): Failed {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return failedWith(error);
  }

  return { thrown: null };
}

describe('credential failures keep their shape', () => {
  test('no key and a short key are unavailable configuration', async () => {
    const none = await rejection(() => createCredentialCipher({}));
    const short = await rejection(() => createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: 'short' }));

    expectClassified(none, 'unavailable');
    expect(none.thrown?.message).toContain('no encryption key is configured');
    expectClassified(short, 'unavailable');
    expect(short.thrown?.message).toContain('too short to be a key (5 chars)');
  });

  test('a record sealed with a key this deployment no longer has, or tampered, is bad input; the tampered one keeps its cause', async () => {
    const retired = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: RETIRED });
    const sealed = await retired.seal('slot', 'secret');
    const current = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: KEY });

    const retiredKey = await rejection(() => current.open('slot', sealed));

    expectClassified(retiredKey, 'bad_input');
    expect(retiredKey.thrown?.message).toMatch(
      /^Record "slot" was sealed with encryption key \S+, which this deployment no longer has\. Restore it in CREDENTIAL_ENCRYPTION_KEY_PREVIOUS, or reconnect the provider\.$/,
    );

    const mine = await current.seal('slot', 'secret');
    const tampered = `${mine.slice(0, -4)}AAAA`;
    const failed = await rejection(() => current.open('slot', tampered));

    expectClassified(failed, 'bad_input');
    expect(failed.thrown?.cause).toBeDefined();
    expectClassified(await rejection(() => current.open('slot', 'pce1.onlyone')), 'bad_input');
  });

  test('a credential whose kind its key cannot spend is bad input', () => {
    expectClassified(thrownBy(() => { credentialToHeaders('codex.oauth', { kind: 'bearer', token: 'sk' }); }), 'bad_input');
  });

  test('unconfigured checkpoint reads throw synchronously, unsupported, not a rejected promise', () => {
    // A synchronous throw never reaches the returned promise; a promise returned here would be the regression.
    let returned: Promise<object> | null = null;
    const failed = thrownBy(() => { returned = fileRestorePlan(null, '/work', 'cp-1'); });

    expect(returned).toBeNull();

    expect(failed.thrown).toBeInstanceOf(Error);
    expectClassified(failed, 'unsupported');
  });
});
