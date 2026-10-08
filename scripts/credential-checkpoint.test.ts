import { afterAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { childEnv, scratchDir } from '@kinu.run/test-utils';

const LOGIN = 'chatgpt.oauth@ashishkmr472';

const SAVED = [{ key: LOGIN, sealed: 'pce1.key.iv.ciphertext' }];

interface Answer {
  checkpoint: readonly object[];
  captureStatus: number;
  restoreStatus: number;
  redirect: string | null;
}

const restores: string[] = [];

let captures = 0;

let elsewhere = 0;

let answer: Answer = { checkpoint: SAVED, captureStatus: 200, restoreStatus: 200, redirect: null };

const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => {
  elsewhere += 1;

  return Response.json([]);
} });

const deployment = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  routes: {
    '/api/user/credential-checkpoint': {
      GET: () => {
        captures += 1;

        return answer.redirect === null
          ? Response.json(answer.checkpoint, { status: answer.captureStatus })
          : Response.redirect(answer.redirect, 302);
      },
      POST: async (request) => {
        restores.push(await request.text());

        return Response.json({ restored: [LOGIN] }, { status: answer.restoreStatus });
      },
    },
  },
});

const ORIGIN = `http://127.0.0.1:${String(deployment.port)}`;

const home = scratchDir('credential-checkpoint');

const file = join(home, '.cache', 'kinu', 'credential-checkpoint', `127.0.0.1:${String(deployment.port)}.json`);

beforeEach(() => {
  captures = 0;
  elsewhere = 0;
  restores.length = 0;
  answer = { checkpoint: SAVED, captureStatus: 200, restoreStatus: 200, redirect: null };
  rmSync(file, { force: true });
});

afterAll(() => {
  deployment.stop(true);
  other.stop(true);
});

async function run(step: 'capture' | 'owed' | 'restore', origin = ORIGIN) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'credential-checkpoint.ts'), step, origin], {
    env: childEnv({ HOME: home, KINU_EVAL_WEB_IDENTITY: 'the-deployment-dev-identity-secret' }), stdout: 'pipe', stderr: 'pipe',
  });

  return child.exited;
}

const kept = () => JSON.parse(readFileSync(file, 'utf8'));

test('a capture keeps the deployment\'s ciphertext until a restore hands it back', async () => {
  expect(await run('capture')).toBe(0);
  expect(kept()).toEqual(SAVED);
  expect(statSync(file).mode & 0o777).toBe(0o600);

  expect(await run('restore')).toBe(0);
  expect(restores.map((body) => JSON.parse(body))).toEqual([SAVED]);
  expect(existsSync(file)).toBe(false);

  expect(await run('restore')).toBe(0);
  expect(restores).toHaveLength(1);
});

test('a key the account still holds is captured afresh; one it lost keeps the record its restore is owed', async () => {
  expect(await run('capture')).toBe(0);

  // A reset refused before it deleted: the live login rotated since, and its newer record wins.
  answer.checkpoint = [{ key: LOGIN, sealed: 'pce1.key.iv.rotated' }];
  expect(await run('capture')).toBe(0);
  expect(kept()).toEqual(answer.checkpoint);

  // A reset whose restore failed: the account lost the key, and only the owed record holds it.
  answer.checkpoint = [{ key: 'opencode-go.bearer', sealed: 'pce1.key.iv.bearer' }];
  expect(await run('capture')).toBe(0);
  expect(kept()).toEqual([{ key: 'opencode-go.bearer', sealed: 'pce1.key.iv.bearer' }, { key: LOGIN, sealed: 'pce1.key.iv.rotated' }]);
});

test('an owed record that does not parse refuses the capture and the resumed reset, and is left as it was', async () => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '[{"key": "chatgpt.oauth@ashishkmr472"}]');

  expect([await run('capture'), await run('owed'), captures]).toEqual([1, 1, 0]);
  expect(readFileSync(file, 'utf8')).toBe('[{"key": "chatgpt.oauth@ashishkmr472"}]');
});

test('a refused capture fails before the reset, and a refused restore keeps the checkpoint for the next deploy', async () => {
  // A build from before the checkpoint route answers it as no route.
  answer.captureStatus = 404;
  expect(await run('capture')).toBe(1);
  expect(existsSync(file)).toBe(false);

  answer.captureStatus = 200;
  expect(await run('capture')).toBe(0);
  answer.restoreStatus = 500;
  expect(await run('restore')).toBe(1);
  expect(existsSync(file)).toBe(true);
});

test('the eval secret goes to an eval target alone, and never follows a redirect', async () => {
  expect(await run('capture', 'https://kinu.example.com')).toBe(1);

  answer.redirect = `http://127.0.0.1:${String(other.port)}/api/user/credential-checkpoint`;
  expect(await run('capture')).toBe(1);
  expect([captures, elsewhere, existsSync(file)]).toEqual([1, 0, false]);
});
