import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { parseJsonc } from '../../jsonc';
import { JsonValueSchema, type JsonValue } from '../../../packages/core/src/utils/json';

const root = resolve(import.meta.dir, '../../..');
const config = parseJsonc(await Bun.file(join(root, 'packages/cf-backend/wrangler.jsonc')).text(),
  v.object({ account_id: v.string() }), 'worker config');
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is required');
const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}`;
const worker = `kinu-hardening-probe-${crypto.randomUUID().slice(0, 8)}`;
const probeSecret = crypto.randomUUID();
const temporary = await mkdtemp(join(tmpdir(), 'kinu-hardening-'));
const configPath = join(temporary, 'wrangler.json');
const started = Date.now();
const evidence = new Map<string, JsonValue>([
  ['date', new Date(started).toISOString()], ['worker', worker], ['account', config.account_id],
]);

async function api(path: string, method = 'GET', body?: JsonValue): Promise<Response> {
  const init: RequestInit = { method,
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${apiRoot}${path}`, init);
  if (!response.ok) throw new Error(`Cloudflare ${method} ${path} returned ${response.status}`);
  return response;
}

const NamesSchema = v.object({ result: v.array(v.object({ name: v.string() })) });
const WorkersSchema = v.object({ result: v.array(v.object({ id: v.string() })) });
const SubdomainSchema = v.object({ result: v.object({ subdomain: v.string() }) });
const ObjectsSchema = v.object({ result: v.array(v.object({ id: v.string() })),
  result_info: v.optional(v.object({ cursor: v.optional(v.string()) })) });
const SettingsSchema = v.object({ result: v.object({ bindings: v.array(v.object({
  name: v.string(), namespace_id: v.optional(v.string()),
})) }) });
let deployed = false;
try {
  const secrets = v.parse(NamesSchema, await (await api('/workers/scripts/kinu-staging/secrets')).json());
  evidence.set('stagingSecretNames', secrets.result.map((row) => row.name));
  await Bun.write(configPath, JSON.stringify({
    name: worker, account_id: config.account_id, main: join(import.meta.dir, 'worker.ts'),
    compatibility_date: '2025-12-01', compatibility_flags: ['nodejs_compat'],
    workers_dev: true, ai: { binding: 'AI' }, worker_loaders: [{ binding: 'LOADER' }],
    vars: { PROBE_WORKSPACE: process.env.KINU_PROBE_WORKSPACE ?? `kinu-probe-${crypto.randomUUID()}` },
    durable_objects: { bindings: [{ name: 'STAGING_AGENT', class_name: 'OrchestratorAgent', script_name: 'kinu-staging' }] },
    observability: { logs: { enabled: true, head_sampling_rate: 1 },
      traces: { enabled: true, head_sampling_rate: 1 } },
  }));
  const deploy = Bun.spawn(['bun', 'node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', configPath], {
    cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(deploy.stdout).text(), new Response(deploy.stderr).text(), deploy.exited,
  ]);
  deployed = true;
  console.log(stdout);
  if (stderr) console.error(stderr);
  if (exit !== 0) throw new Error(`Fixture deploy exited ${exit}`);
  await api(`/workers/scripts/${worker}/secrets`, 'PUT', { name: 'PROBE_SECRET', text: probeSecret, type: 'secret_text' });
  const subdomain = v.parse(SubdomainSchema, await (await api('/workers/subdomain')).json()).result.subdomain;
  const origin = `https://${worker}.${subdomain}.workers.dev`;
  evidence.set('origin', origin);
  // A fresh workers.dev name propagates in seconds most of the time and in
  // tens of seconds some of the time; the loop records what each observation
  // saw so a run that gives up says what it was still waiting on.
  let ready = false;
  const observed: string[] = [];
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${origin}/trace`, { headers: { authorization: `Bearer ${probeSecret}` } });
      if (response.ok) { ready = true; break; }
      observed.push(String(response.status));
      await response.body?.cancel();
    } catch (cause) {
      observed.push(cause instanceof Error ? cause.message : String(cause));
    }
    await Bun.sleep(500);
  }
  evidence.set('propagation', { observations: observed.length, distinct: [...new Set(observed)] });
  if (!ready) throw new Error(`Fixture deployment did not propagate in ${String(observed.length)} observations: ${[...new Set(observed)].join(' | ')}`);
  const paths = process.argv.slice(2);
  for (const path of paths.length ? paths : ['/trace', '/abort-first', '/finish-first', '/replay', '/egress', '/webhook']) {
    const response = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${probeSecret}` } });
    const text = await response.text();
    const observation = { status: response.status, value: response.headers.get('content-type')?.includes('application/json')
      ? v.parse(JsonValueSchema, JSON.parse(text)) : text.slice(0, 240) };
    evidence.set(path, observation);
    console.log(JSON.stringify({ path, ...observation }, null, 2));
  }
  const settings = v.parse(SettingsSchema, await (await api('/workers/scripts/kinu-staging/settings')).json());
  const namespace = settings.result.bindings.find((binding) => binding.name === 'OrchestratorAgent')?.namespace_id;
  if (!namespace) throw new Error('Staging OrchestratorAgent namespace is missing');
  const objectIds = new Set<string>();
  let cursor = '';
  do {
    const page = v.parse(ObjectsSchema, await (await api(`/workers/durable_objects/namespaces/${namespace}/objects?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json());
    page.result.forEach((object) => objectIds.add(object.id));
    cursor = page.result_info?.cursor ?? '';
  } while (cursor);
  const webhook = v.safeParse(v.object({ value: v.object({ victimId: v.string() }) }), evidence.get('/webhook'));
  if (webhook.success) evidence.set('unsignedVictimActivated', objectIds.has(webhook.output.value.victimId));
  evidence.set('stagingNamespace', namespace);
  const trace = await api('/workers/observability/telemetry/query', 'POST', {
    queryId: `hardening-${worker}`, timeframe: { from: started, to: Date.now() },
    view: 'events', limit: 20, parameters: { filters: [
      { key: '$metadata.service', type: 'string', operation: 'eq', value: worker },
      { key: 'name', type: 'string', operation: 'eq', value: 'fetch.hardening_probe' },
    ] },
  });
  const spans = v.parse(v.object({ result: v.object({ events: v.object({ events: v.array(v.object({
    source: v.object({ name: v.string(), traceId: v.string(), spanId: v.string(),
      kinu: v.object({ self_path: v.string(), isolate_gen: v.number() }) }),
  })) }) }) }), await trace.json());
  evidence.set('traceSpans', spans.result.events.events.map((event) => event.source));
} finally {
  if (deployed) {
    await api(`/workers/scripts/${worker}?force=true`, 'DELETE');
    const workers = v.parse(WorkersSchema, await (await api('/workers/scripts')).json());
    evidence.set('teardown', { workerAbsent: !workers.result.some((entry) => entry.id === worker) });
  }
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(Object.fromEntries(evidence), null, 2));
}
// The probes above fail loudly on their own; this is the one claim the run
// makes about the account after them, so it is checked last and on its own.
const teardown = v.safeParse(v.object({ workerAbsent: v.literal(true) }), evidence.get('teardown'));
if (deployed && !teardown.success) throw new Error('Fixture remains after teardown');
