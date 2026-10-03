// The CLI rates turns through the Workers AI endpoint its resolver routes a chat model to, as CL-Bench configures it
// (`KINU_BASE_URL` / `KINU_AUTH`), with no `kinu login` session: the decision model runs at `/ai/run` beside it.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initWorkspaceSchema } from '@kinu.run/core';
import { scratchPath } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession } from '../src/local-session';
import { fakeModel } from './helpers/local-session';
import { CLEF_BINDING_ANSWER } from '../../core/tests/fixtures/clef-binding-answer';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

/** A Workers AI-shaped endpoint: the REST wrapping of Clef's measured answer, read as "builds on it". */
function endpoint(base = '/api/user/ai/v1') {
  const seen: Array<{ path: string; auth: string | null }> = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization') });
      const answers = { ...CLEF_BINDING_ANSWER.answers, satisfaction: { ...CLEF_BINDING_ANSWER.answers.satisfaction, score: 3.6 } };

      return Response.json({ result: { ...CLEF_BINDING_ANSWER, answers }, success: true });
    },
  });

  servers.push(server);

  return { baseURL: `http://127.0.0.1:${String(server.port)}${base}`, seen };
}

describe('the CLI decision route', () => {
  test('a KINU_BASE_URL Workers AI endpoint rates an answered turn, with no signed-in session', async () => {
    const { baseURL, seen } = endpoint();
    const db = new Database(scratchPath('decision-route', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));

    const rt = createCLIRuntime(db, {
      llm: { name: 'workers-ai', baseURL, headers: { Authorization: 'Bearer bench-token' }, model: '@cf/moonshotai/kimi-k2.6' },
    });

    const session = new LocalAgentSession({ rt, db, model: fakeModel('Rotated the staging keys.'), onEvent: () => {} });

    try {
      await session.send('please rotate the API keys for the staging cluster', { id: crypto.randomUUID() });
      await session.send('great, now the production cluster', { id: crypto.randomUUID() });
      await session.end();

      expect(db.query<{ source: string; score: number }, []>('SELECT source, score FROM turn_ratings').all())
        .toEqual([{ source: 'model', score: 4.6 }]);
      expect(seen).toEqual([{ path: '/api/user/ai/run/@cf/cloudflare/clef', auth: 'Bearer bench-token' }]);
    } finally {
      db.close();
    }
  });

  test('a Workers AI endpoint with no `/ai/v1` base, as an AI Gateway serves one, is asked no rating', async () => {
    const { baseURL, seen } = endpoint('/v1/acct/gateway/workers-ai/v1');
    const db = new Database(scratchPath('decision-route-gateway', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));

    const rt = createCLIRuntime(db, {
      llm: { name: 'workers-ai', baseURL, headers: { Authorization: 'Bearer bench-token' }, model: '@cf/moonshotai/kimi-k2.6' },
    });

    const session = new LocalAgentSession({ rt, db, model: fakeModel('Rotated the staging keys.'), onEvent: () => {} });

    try {
      await session.send('please rotate the API keys for the staging cluster', { id: crypto.randomUUID() });
      await session.send('great, now the production cluster', { id: crypto.randomUUID() });
      await session.end();

      expect(seen).toEqual([]);
      expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM turn_ratings').all()).toEqual([{ n: 0 }]);
    } finally {
      db.close();
    }
  });
});
