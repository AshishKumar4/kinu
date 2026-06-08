import { describe, expect, test } from 'bun:test';
import { createSession, verifySession, type OAuthProfile } from '../src/auth/d1-store.js';
import { createAuthDatabase, makeD1 } from './helpers/d1.js';

function setupEnv() {
  const db = createAuthDatabase();
  const ensuredProfiles: string[] = [];
  const userDO = {
    async ensureProfile(email: string, displayName?: string) {
      ensuredProfiles.push(`${email}:${displayName ?? ''}`);
      return { email, displayName };
    },
  };

  return {
    db,
    ensuredProfiles,
    env: {
      AUTH_DB: makeD1(db),
      UserDO: {
        idFromName(name: string) { return name; },
        get() { return userDO; },
      },
    } as unknown as Env,
  };
}

describe('D1-backed browser auth store', () => {
  test('first verified OAuth login creates user before email link and session', async () => {
    const { db, env, ensuredProfiles } = setupEnv();

    const created = await createSession(env, {
      provider: 'cloudflare',
      providerSub: 'cf-user-1',
      email: 'Ashish@Example.com',
      emailVerified: true,
      displayName: 'Ashish',
      avatarUrl: null,
    });

    expect(created.token).toStartWith('ps_');
    expect(created.identity.email).toBe('ashish@example.com');
    expect(ensuredProfiles).toEqual(['ashish@example.com:Ashish']);

    const user = db.prepare('SELECT id, email FROM auth_users').get() as { id: string; email: string };
    const link = db.prepare('SELECT email, user_id FROM auth_email_links').get() as { email: string; user_id: string };
    const session = db.prepare('SELECT user_id, provider, provider_account_id FROM auth_sessions').get() as {
      user_id: string; provider: string; provider_account_id: string;
    };

    expect(user.id).toBe(created.identity.userId);
    expect(user.email).toBe('ashish@example.com');
    expect(link).toEqual({ email: 'ashish@example.com', user_id: created.identity.userId });
    expect(session).toEqual({
      user_id: created.identity.userId,
      provider: 'cloudflare',
      provider_account_id: 'cf-user-1',
    });

    const verified = await verifySession(env.AUTH_DB, created.token, created.bookmark);
    expect(verified.identity?.userId).toBe(created.identity.userId);
  });

  test('verified email link reuses the same Proteus user across providers', async () => {
    const { db, env } = setupEnv();
    const first = await createSession(env, profile('cloudflare', 'cf-user-1', 'person@example.com'));
    const second = await createSession(env, profile('google', 'google-user-1', 'PERSON@example.com'));

    expect(second.identity.userId).toBe(first.identity.userId);
    expect(db.prepare('SELECT COUNT(*) as count FROM auth_users').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) as count FROM auth_accounts').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) as count FROM auth_sessions').get()).toEqual({ count: 2 });
  });
});

function profile(provider: OAuthProfile['provider'], providerSub: string, email: string): OAuthProfile {
  return {
    provider,
    providerSub,
    email,
    emailVerified: true,
    displayName: null,
    avatarUrl: null,
  };
}
