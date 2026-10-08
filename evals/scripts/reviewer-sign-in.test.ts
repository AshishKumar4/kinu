import { afterAll, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import * as v from 'valibot';
import type { ModelTestResult } from '@kinu.run/core';
import { childEnv } from '@kinu.run/test-utils';
import { REVIEW_ACCOUNTS, reviewLogin } from '../src/config';

// Resets are rare and every deploy runs this, so the owner is asked to approve a login only when the deployment lacks
// it, and never by a run that has no terminal to ask at.

const IDENTITY = 'the-deployment-dev-identity-secret';

const held = new Set<string>();

const starts: string[] = [];

const deployment = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  routes: {
    '/api/user/credentials': () => Response.json([...held].map((key) => ({ key, kind: 'oauth' }))),
    '/api/user/chatgpt/paste/start': {
      POST: async (request) => {
        starts.push(await request.text());

        return Response.json({ authorizeUrl: 'https://auth.openai.com/api/accounts/authorize', redirectUri: 'http://localhost:1455/auth/callback' });
      },
    },
    // As the product answers: a real call through the spec's own account, which only a held login can make.
    '/api/user/models/test': {
      POST: async (request) => {
        const { spec } = v.parse(v.object({ spec: v.string() }), await request.json());
        const login = REVIEW_ACCOUNTS.map(reviewLogin).find((each) => each.spec === spec);

        const result: ModelTestResult = login !== undefined && held.has(login.key)
          ? { ok: true, firstTokenMs: 400, totalMs: 900 }
          : { ok: false, failure: 'signed-out', message: `No usable chatgpt credential for "${spec}"` };

        return Response.json(result);
      },
    },
  },
});

const ORIGIN = `http://127.0.0.1:${String(deployment.port)}`;

beforeEach(() => {
  held.clear();
  starts.length = 0;
});

afterAll(() => deployment.stop(true));

/** The script as a deploy runs it unattended: its stdin a pipe, never a terminal. Run apart from this process, whose
 *  event loop answers it as the deployment. */
async function run() {
  const child = Bun.spawn([process.execPath, join(import.meta.dirname, 'reviewer-sign-in.ts'), ORIGIN], {
    env: childEnv({ KINU_EVAL_WEB_IDENTITY: IDENTITY, KINU_DEPLOY_REPORT: '' }), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });

  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

  return { status, output: `${stdout}${stderr}` };
}

test('a deployment holding both logins is asked nothing, and the reviewer answers on each', async () => {
  for (const account of REVIEW_ACCOUNTS) held.add(reviewLogin(account).key);

  const { status, output } = await run();

  expect({ status, starts }).toEqual({ status: 0, starts: [] });

  for (const account of REVIEW_ACCOUNTS) expect(output).toContain(`${reviewLogin(account).spec} answers at ${ORIGIN}`);
});

test('a login a reset wiped is named, with the command that asks for it, and no sign-in starts without a terminal', async () => {
  held.add(reviewLogin(REVIEW_ACCOUNTS[0]).key);

  const { status, output } = await run();

  expect({ status, starts }).toEqual({ status: 1, starts: [] });
  expect(output).toContain(`lacks the reviewer's login ${REVIEW_ACCOUNTS[1]}`);
  expect(output).toContain(`run bun evals/scripts/reviewer-sign-in.ts ${ORIGIN}`);
});
