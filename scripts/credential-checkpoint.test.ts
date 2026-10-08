import { afterAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, scratchDir } from '@kinu.run/test-utils';

const SAVED = [{ key: 'chatgpt.oauth@ashishkmr472', sealed: 'pce1.key.iv.ciphertext' }];

interface Answer {
  checkpoint: readonly object[];
  saveStatus: number;
  restoreStatus: number;
}

const restores: string[] = [];

let saves = 0;

let answer: Answer = { checkpoint: SAVED, saveStatus: 200, restoreStatus: 200 };

const deployment = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  routes: {
    '/api/user/credential-checkpoint': {
      GET: () => {
        saves += 1;

        return Response.json(answer.checkpoint, { status: answer.saveStatus });
      },
      POST: async (request) => {
        restores.push(await request.text());

        return Response.json({ restored: ['chatgpt.oauth@ashishkmr472'] }, { status: answer.restoreStatus });
      },
    },
  },
});

const ORIGIN = `http://127.0.0.1:${String(deployment.port)}`;

const home = scratchDir('credential-checkpoint');

const file = join(home, '.cache', 'kinu', 'credential-checkpoint', `127.0.0.1:${String(deployment.port)}.json`);

beforeEach(() => {
  saves = 0;
  restores.length = 0;
  answer = { checkpoint: SAVED, saveStatus: 200, restoreStatus: 200 };
});

afterAll(() => deployment.stop(true));

async function run(step: 'save' | 'restore') {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'credential-checkpoint.ts'), step, ORIGIN], {
    env: childEnv({ HOME: home, KINU_EVAL_WEB_IDENTITY: 'the-deployment-dev-identity-secret' }), stdout: 'pipe', stderr: 'pipe',
  });

  return child.exited;
}

test('a save keeps the deployment\'s ciphertext until a restore hands it back, and a rerun keeps a restore still owed', async () => {
  expect(await run('save')).toBe(0);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(SAVED);
  expect(statSync(file).mode & 0o777).toBe(0o600);

  // A reset that stopped after its wipe deploys again: the account it reads then is empty.
  answer.checkpoint = [];
  expect(await run('save')).toBe(0);
  expect({ saves, kept: JSON.parse(readFileSync(file, 'utf8')) }).toEqual({ saves: 1, kept: SAVED });

  expect(await run('restore')).toBe(0);
  expect(restores.map((body) => JSON.parse(body))).toEqual([SAVED]);
  expect(existsSync(file)).toBe(false);

  expect(await run('restore')).toBe(0);
  expect(restores).toHaveLength(1);
});

test('a refused capture fails before the reset, and a refused restore keeps the checkpoint for the next deploy', async () => {
  // A build from before the checkpoint route answers it as no route.
  answer.saveStatus = 404;
  expect(await run('save')).toBe(1);
  expect(existsSync(file)).toBe(false);

  answer.saveStatus = 200;
  expect(await run('save')).toBe(0);
  answer.restoreStatus = 500;

  expect(await run('restore')).toBe(1);
  expect(existsSync(file)).toBe(true);

  answer.restoreStatus = 200;
  expect(await run('restore')).toBe(0);
  expect(existsSync(file)).toBe(false);
});
