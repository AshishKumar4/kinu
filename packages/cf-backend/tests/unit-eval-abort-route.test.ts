/** The eval-only abort route admits only the eval-service identity; the real `ctx.abort` is driven by the workerd
 *  `do-eviction-recovery` and `eval-abort` probes. */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { AuthIdentity } from '../src/auth/session';
import { evalAbortRoutes } from '../src/eval/abort-route';
import { serveFamily } from './helpers/api';

const PERSON: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef', email: 'ashish@example.com', sub: 'sub', provider: 'google', authTime: 1,
};

const EVAL_SERVICE: AuthIdentity = {
  userId: 'fedcba9876543210fedcba9876543210', email: 'eval-service@kinu.run', sub: 'dev', provider: 'dev', authTime: 1,
};

const post = (path: string) => new Request(`https://kinu.run${path}`, { method: 'POST' });

describe('the eval-only abort route', () => {
  test('a person\'s session is refused as not found, and the object is never asked', async () => {
    let asked = 0;
    const response = await serveFamily(evalAbortRoutes, { identity: PERSON, workspace: { name: 'ws-1', agent: { evalAbortActivation: async () => { asked += 1; } } } })(post('/api/workspaces/ws-1/eval/abort'), {});

    expect(response?.status).toBe(404);
    expect(asked).toBe(0);
  });

  test('the eval-service identity ends the activation; the stub\'s rejection is the receipt', async () => {
    let asked = 0;

    const response = await serveFamily(evalAbortRoutes, { identity: EVAL_SERVICE, workspace: { name: 'ws-1', agent: { evalAbortActivation: async () => {
      asked += 1;
      throw new Error('Durable Object reset: eval-service: the activation was aborted on request');
    } } } })(post('/api/workspaces/ws-1/eval/abort'), {});

    expect(asked).toBe(1);

    if (response === null) throw new Error('the eval-service identity was not answered');
    expect(response.status).toBe(202);
    expect(v.parse(v.object({ aborted: v.boolean() }), await response.json())).toEqual({ aborted: true });
  });

  test('any other path or method is not this route', async () => {
    expect(await serveFamily(evalAbortRoutes, { identity: EVAL_SERVICE, workspace: { name: 'ws-1', agent: { evalAbortActivation: async () => {} } } })(post('/api/workspaces/ws-1/runs'), {})).toBeNull();
    expect(await serveFamily(evalAbortRoutes, { identity: EVAL_SERVICE, workspace: { name: 'ws-1', agent: { evalAbortActivation: async () => {} } } })(new Request('https://kinu.run/api/workspaces/ws-1/eval/abort'), {})).toBeNull();
  });
});
