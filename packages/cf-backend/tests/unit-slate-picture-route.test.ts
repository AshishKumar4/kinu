/**
 * `GET /api/user/pictures/:workspace/:slate/:digest`: the owner's roster answers who may see a picture, and no
 * workspace is asked, so a Drive of tiles wakes none; a digest names one version, kept for good.
 */
import { describe, expect, test } from 'bun:test';
import type { UserCaller } from '@kinu.run/core';
import { pictureKey } from '../src/slates/pictures';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';
import { serveFamily } from './helpers/api';
import { bootstrappedProfile, userAccount } from './helpers/bindings';
import { memoryBucket } from './helpers/r2';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now(),
};

const DIGEST = 'a'.repeat(64);

const WEBP = new Uint8Array([82, 73, 70, 70]);

function pictureRoute() {
  const bucket = memoryBucket();
  const asked: string[] = [];

  const stub = userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async userMcp_warmConnections() { return { servers: 0 }; },
    async hasWorkspace(_caller: UserCaller, name: string) { return name === 'ledger'; },
  });

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => stub },
    OrchestratorAgent: {
      idFromName: (name) => name,
      get: (id) => {
        asked.push(id);
        throw new Error('a picture asked its workspace');
      },
    },
    SLATE_PICTURES: bucket,
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const ctx = { waitUntil() {} };

  const get = async (path: string): Promise<Response> => {
    const answer = await serveFamily(userRoutes, { identity: IDENTITY, ctx })(
      new Request(`https://kinu.example.com/api/user/pictures/${path}`), env,
    );

    if (answer === null) throw new Error(`no route answered ${path}`);

    return answer;
  };

  return { bucket, asked, get };
}

describe("a slate's picture", () => {
  test("is its workspace owner's to see, kept for good, and asks no workspace", async () => {
    const { bucket, asked, get } = pictureRoute();
    await bucket.put(pictureKey('ledger', 'board', DIGEST), WEBP, { httpMetadata: { contentType: 'image/webp' } });

    const shown = await get(`ledger/board/${DIGEST}`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).toBe('image/webp');
    expect(shown.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(WEBP);
    expect(asked).toEqual([]);
  });

  test('is a 404 for a workspace not on the roster, an unknown version and a malformed digest', async () => {
    const { bucket, get } = pictureRoute();
    await bucket.put(pictureKey('notes', 'board', DIGEST), WEBP, { httpMetadata: { contentType: 'image/webp' } });

    expect((await get(`notes/board/${DIGEST}`)).status).toBe(404);
    expect((await get(`ledger/board/${'b'.repeat(64)}`)).status).toBe(404);
    expect((await get('ledger/board/not-a-digest')).status).toBe(404);
  });
});
