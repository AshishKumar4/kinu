/**
 * kinu-ci-runner: Kinu's CI tier on Cloudflare Containers, for any commit a lane or Main has made, pushed or not.
 * `scripts/ci-remote.ts` is its one client; every route takes the bearer in `~/.config/kinu/ci-token`. The release
 * gate stays GitHub CI; a graded run's verdict file is kept here, in the same schema, under `verdicts/<sha>`.
 */
import * as v from 'valibot';
import { environmentKey, ManifestSchema, PackBase, PREPARATION, Sha, StartSchema, TimingsSchema } from './contract';
import { packKey, SINGLE, type Env } from './env';

export { CiRun } from './run';

export { CiShard } from './shard';

export { CiEnvironments, CiPreparer } from './environments';

export { CiTimings } from './timings';

/** The bearer, compared in constant time. */
function authorized(request: Request, env: Env): boolean {
  const expected = new TextEncoder().encode(`Bearer ${env.CI_TOKEN}`);
  const supplied = new TextEncoder().encode(request.headers.get('authorization') ?? '');

  return env.CI_TOKEN.length >= 32 && expected.length === supplied.length && crypto.subtle.timingSafeEqual(expected, supplied);
}

function runId(sha: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14);

  return `${stamp}-${sha.slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;
}

const notFound = (): Response => Response.json({ error: 'not found' }, { status: 404 });

/** An R2 object as the response body, or 404. */
async function object(env: Env, key: string | undefined): Promise<Response> {
  const found = key === undefined ? null : await env.ARTIFACTS.get(key);

  if (found === null) return notFound();
  const headers = new Headers();

  found.writeHttpMetadata(headers);

  return new Response(found.body, { headers });
}

type Handler = (request: Request, env: Env, path: readonly string[]) => Promise<Response | undefined>;

/** `/packs/<sha>/<base>`: a commit's pack, stored once (`packKey`). */
const packs: Handler = async (request, env, [sha, base]) => {
  if (sha === undefined || base === undefined || !v.is(Sha, sha) || !v.is(PackBase, base)) return undefined;
  const key = packKey(sha, base);

  if (request.method === 'HEAD') return new Response(null, { status: (await env.ARTIFACTS.head(key)) === null ? 404 : 200 });

  if (request.method !== 'PUT' || request.body === null) return undefined;
  await env.ARTIFACTS.put(key, request.body);

  return Response.json({ stored: key });
};

/** `POST /runs` starts one; `/runs/<id>` is its status, `/cancel` ends it, `/parts/<name>/{output,log}` its pieces. */
const runs: Handler = async (request, env, [id, tail, part, leaf]) => {
  if (id === undefined) {
    if (request.method !== 'POST') return undefined;
    const start = v.parse(StartSchema, await request.json());

    if ((await env.ARTIFACTS.head(packKey(start.sha, start.base))) === null) return Response.json({ error: `upload the pack of ${start.sha} first` }, { status: 409 });
    const created = runId(start.sha);

    await env.CI_RUN.getByName(created).create({ ...start, runId: created });

    return Response.json({ runId: created });
  }

  const run = env.CI_RUN.getByName(id);

  if (tail === undefined) return Response.json(await run.status() ?? { error: 'no such run' });

  if (tail === 'cancel' && request.method === 'POST') {
    await run.cancel('cancelled by its client');

    return Response.json({ cancelled: id });
  }

  return tail === 'parts' && part !== undefined && (leaf === 'output' || leaf === 'log') ? await object(env, (await run.keys(part))?.[leaf]) : undefined;
};

/** `/verdicts/<sha>`: a graded run's collected verdict file, in the schema `scripts/ci-verdicts.ts` reads. */
const verdicts: Handler = async (request, env, [sha]) => {
  if (sha === undefined || !v.is(Sha, sha)) return undefined;
  const key = `verdicts/${sha}/all.json`;

  if (request.method === 'GET') return await object(env, key);

  if (request.method !== 'PUT') return undefined;
  const file = v.parse(v.object({ sha: v.literal(sha), part: v.literal('all'), rows: v.array(v.looseObject({ run: v.string(), exitCode: v.number() })) }), await request.json());

  await env.ARTIFACTS.put(key, JSON.stringify(file), { httpMetadata: { contentType: 'application/json' } });

  return Response.json({ stored: key });
};

const timings: Handler = async (request, env) => {
  if (request.method !== 'POST') return undefined;
  await env.CI_TIMINGS.getByName(SINGLE).record(v.parse(TimingsSchema, await request.json()));

  return Response.json({ recorded: true });
};

/** `/environments` lists them, `POST /environments/resolve` names the key and pack base of a manifest, and
 *  `DELETE /environments/<key>` forgets one whose snapshot was pruned. */
const environments: Handler = async (request, env, [key]) => {
  const registry = env.CI_ENVIRONMENTS.getByName(SINGLE);

  if (key === undefined) return Response.json(await registry.list());

  if (key === 'resolve' && request.method === 'POST') {
    const resolved = await environmentKey(v.parse(v.object({ manifest: ManifestSchema }), await request.json()).manifest);

    return Response.json({ key: resolved, base: await registry.base(resolved) });
  }

  if (request.method !== 'DELETE') return undefined;
  await registry.forget(key);

  return Response.json({ forgotten: key });
};

const ROUTES: ReadonlyMap<string, Handler> = new Map([['packs', packs], ['runs', runs], ['verdicts', verdicts], ['timings', timings], ['environments', environments]]);

async function route(request: Request, env: Env): Promise<Response> {
  const [head = '', ...path] = new URL(request.url).pathname.split('/').filter((segment) => segment !== '');

  if (head === 'health') return Response.json({ ok: true, preparation: PREPARATION });

  return await ROUTES.get(head)?.(request, env, path) ?? notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) return Response.json({ error: 'forbidden' }, { status: 403 });

    try {
      return await route(request, env);
    } catch (cause) {
      if (cause instanceof v.ValiError) return Response.json({ error: cause.message }, { status: 400 });
      throw cause;
    }
  },
} satisfies ExportedHandler<Env>;
