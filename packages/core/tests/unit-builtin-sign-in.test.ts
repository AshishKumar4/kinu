import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { firstOwnerLinkEmail, firstOwnerLinkSecret } from '../src/identity';

const TOKEN = 'one-time owner link';

const DIGEST = createHash('sha256').update(TOKEN).digest('hex');

const EMAIL = 'first.owner@example.com';

const NOW = 1_800_000_000_000;

const EXPIRES_AT = NOW + 7 * 24 * 60 * 60 * 1000;

const LINK = `${DIGEST}.${EXPIRES_AT}.${EMAIL}`;

describe('first-owner setup link admission', () => {
  test('a matching, unexpired token admits only its email, including dots', () => {
    expect(firstOwnerLinkEmail(LINK, TOKEN, NOW)).toBe(EMAIL);
    expect(firstOwnerLinkEmail(`${DIGEST}.${EXPIRES_AT}.First.Owner@Example.com`, TOKEN, NOW)).toBe(EMAIL);
  });

  test('the deploy run encodes a secret the reader admits', () => {
    const secret = firstOwnerLinkSecret(TOKEN, EXPIRES_AT, EMAIL);

    expect(secret).toBe(LINK);
    expect(firstOwnerLinkEmail(secret, TOKEN, NOW)).toBe(EMAIL);
  });

  test('a wrong or missing token admits nobody', () => {
    expect(firstOwnerLinkEmail(LINK, 'another token', NOW)).toBeNull();
    expect(firstOwnerLinkEmail(LINK, null, NOW)).toBeNull();
    expect(firstOwnerLinkEmail(LINK, '', NOW)).toBeNull();
  });

  test('the expiry instant and any later time admit nobody', () => {
    expect(firstOwnerLinkEmail(LINK, TOKEN, EXPIRES_AT)).toBeNull();
    expect(firstOwnerLinkEmail(LINK, TOKEN, EXPIRES_AT + 1)).toBeNull();
  });

  test.each([
    '', DIGEST, `${DIGEST}.${EXPIRES_AT}`, `${TOKEN}.${EXPIRES_AT}.${EMAIL}`,
    `${DIGEST}.Infinity.${EMAIL}`, `${DIGEST}.1e15.${EMAIL}`, `${DIGEST}.9007199254740992.${EMAIL}`,
    `${DIGEST}.${EXPIRES_AT}.`, `${DIGEST}.${EXPIRES_AT}.not-an-email`, `${DIGEST}.${EXPIRES_AT}.two@@example.com`,
    `${DIGEST}.${EXPIRES_AT}.first owner@example.com`,
  ])('a malformed secret admits nobody: %s', (link) => {
    expect(firstOwnerLinkEmail(link, TOKEN, NOW)).toBeNull();
  });

  test('an absent secret admits nobody', () => {
    expect(firstOwnerLinkEmail(undefined, TOKEN, NOW)).toBeNull();
  });
});
