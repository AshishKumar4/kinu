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

describe('resolveOrCreateIdentity efficiency and orphan safety', () => {
  function envWithCounter(db: ReturnType<typeof createAuthDatabase>, onQuery?: (q: string) => void) {
    const userDO = { async ensureProfile() {} };
    return {
      AUTH_DB: makeD1(db, onQuery),
      UserDO: { idFromName(name: string) { return name; }, get() { return userDO; } },
    } as unknown as Env;
  }

  test('exactly one auth_users upsert per login', async () => {
    const db = createAuthDatabase();
    let userUpserts = 0;
    const env = envWithCounter(db, (q) => { if (q.includes('INSERT INTO auth_users')) userUpserts += 1; });

    await createSession(env, profile('cloudflare', 'cf-user-1', 'person@example.com'));
    expect(userUpserts).toBe(1);

    userUpserts = 0;
    await createSession(env, profile('google', 'google-user-1', 'person@example.com'));
    expect(userUpserts).toBe(1);
  });

  test('losing a concurrent email-link race leaves no orphan auth_users row', async () => {
    const db = createAuthDatabase();
    const winnerId = 'f'.repeat(32);
    let raceArmed = true;
    const env = envWithCounter(db, (q) => {
      // Just before this login claims the email link, a concurrent login
      // for the same verified email wins the race.
      if (raceArmed && q.includes('INSERT INTO auth_email_links')) {
        raceArmed = false;
        db.prepare(
          `INSERT INTO auth_users (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, 1, 1)`,
        ).run(winnerId, 'person@example.com');
        db.prepare(
          `INSERT INTO auth_email_links (email, user_id, created_at, updated_at) VALUES (?, ?, 1, 1)`,
        ).run('person@example.com', winnerId);
      }
    });

    const created = await createSession(env, profile('github', 'gh-user-1', 'person@example.com'));

    expect(created.identity.userId).toBe(winnerId);
    // The provisional row minted by the losing login must be gone.
    expect(db.prepare('SELECT COUNT(*) as count FROM auth_users').get()).toEqual({ count: 1 });
    const account = db.prepare('SELECT user_id FROM auth_accounts WHERE provider = ?').get('github') as { user_id: string };
    expect(account.user_id).toBe(winnerId);
  });
});
