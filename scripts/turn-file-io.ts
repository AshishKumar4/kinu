/** Exact-built-bundle workerd measurements. Run only on armada; model inference is a zero-delay script outside workerd. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { createServer } from 'node:net';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ownerCaller, type JsonObject } from '@kinu.run/core';
import * as v from 'valibot';
import { workersAiBinding, readAiRun, workersAiAnswer } from '../packages/cf-backend/tests/helpers/workers-ai-binding';
import { buildAgentBundle, writeWhole } from '../packages/cf-backend/vite-agent-bundle';
import { readScriptedRequest, SCRIPTED_MODELS_BODY, scriptedBody, type ScriptedAnswer } from './scripted-protocol';
import { SliceSchema } from './turn-file-io/meter';

const root = join(import.meta.dir, '..');

const dist = join(root, 'packages/cf-backend/dist/kinu');

const option = (name: string, fallback: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const subject = option('shape', 'short');

const mode = option('mode', 'counts');

const sha = option('sha', '26244c765');

const isolated = sha !== 'd05ff368d';

const samples = Number(option('samples', '30'));

const BuiltConfigSchema = v.object({
  compatibility_date: v.string(), compatibility_flags: v.array(v.string()), vars: v.record(v.string(), v.string()),
  assets: v.object({ binding: v.string(), directory: v.string() }),
  r2_buckets: v.array(v.object({ binding: v.string() })), kv_namespaces: v.array(v.object({ binding: v.string() })),
  durable_objects: v.object({ bindings: v.array(v.object({ name: v.string(), class_name: v.string() })) }),
});

const ManifestSchema = v.record(v.string(), v.object({ file: v.string(), assets: v.optional(v.array(v.string())) }));

const HeapReplySchema = v.object({ id: v.optional(v.number()), result: v.optional(v.object({ usedSize: v.number() })), error: v.optional(v.object({ message: v.string() })) });

type HeapReply = v.InferOutput<typeof HeapReplySchema>;

const TargetsSchema = v.array(v.object({ id: v.string(), webSocketDebuggerUrl: v.string() }));

const CutSchema = v.object({ workspace: SliceSchema, facet: v.nullable(SliceSchema) });

type Cut = v.InferOutput<typeof CutSchema>;

interface TurnMeasurement { readonly text: string; readonly wallMs: number; readonly cpuMs: number; phases?: Cut[] }

interface DriverRequest { method?: string; body?: string }

async function bundle(file: string): Promise<string> {
  const result = await build({
    entryPoints: [join(import.meta.dir, 'turn-file-io', file)], bundle: true, write: false, format: 'esm',
    platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
    alias: Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, `node:${name}`])),
    external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'product', setup: (plugin) => {
      plugin.onResolve({ filter: /^kinu:product$/ }, () => ({ path: './index.js', external: true }));
    } }],
  });

  if (result.outputFiles[0] === undefined) throw new Error(`no bundle for ${file}`);

  return result.outputFiles[0].text;
}

async function productModules() {
  const manifest = v.parse(ManifestSchema, JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8')));
  const files = new Set(['index.js', ...Object.values(manifest).flatMap((entry) => [entry.file, ...(entry.assets ?? [])])]);

  const emitted = [...files].filter((file) => /\.(js|wasm)$/u.test(file)).map((file) => ({
    type: file.endsWith('.wasm') ? 'CompiledWasm' as const : 'ESModule' as const,
    path: join(dist, file), contents: file.endsWith('.wasm') ? readFileSync(join(dist, file)) : readFileSync(join(dist, file), 'utf8'),
  }));

  return [{ type: 'ESModule' as const, path: join(dist, 'perf-product.js'), contents: await bundle('product.ts') }, ...emitted];
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();

  if (typeof address !== 'object' || address === null) throw new Error('no inspector address');
  await new Promise<void>((done) => server.close(() => done()));

  return address.port;
}

/** Scheduler nanoseconds consumed by every thread of this one workerd process, not the model/driver host process. */
function cpu(pid: number): number {
  return readdirSync(`/proc/${String(pid)}/task`).reduce((sum, tid) => {
    const elapsed = Number(readFileSync(`/proc/${String(pid)}/task/${tid}/schedstat`, 'utf8').split(' ')[0]);

    return sum + elapsed / 1e6;
  }, 0);
}

function workerdPid(): number {
  const children = readFileSync(`/proc/${String(process.pid)}/task/${String(process.pid)}/children`, 'utf8').trim().split(/\s+/u).map(Number);
  const selected = children.find((pid) => pid > 0 && readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes('workerd'));

  if (selected === undefined) throw new Error(`no workerd among children ${children.join(',')}`);

  return selected;
}

interface Inspector {
  heap(): Promise<number>;
  close(): void;
}

async function connectInspector(url: string): Promise<Inspector> {
  const socket = new WebSocket(url);
  const opened = Promise.withResolvers<void>();
  const replies = new Map<number, (reply: HeapReply) => void>();
  let id = 0;
  socket.addEventListener('open', () => { opened.resolve(); });
  socket.addEventListener('error', () => opened.reject(new Error(`inspector failed: ${url}`)));
  socket.addEventListener('message', (event) => {
    const parsed = v.safeParse(HeapReplySchema, JSON.parse(String(event.data)));

    if (!parsed.success) return;
    const reply = parsed.output;

    if (reply.id !== undefined) replies.get(reply.id)?.(reply);
  });
  await opened.promise;

  return {
    heap: async () => {
      const pending = Promise.withResolvers<HeapReply>();
      replies.set(++id, pending.resolve);
      socket.send(JSON.stringify({ id, method: 'Runtime.getHeapUsage' }));
      const reply = await pending.promise;
      replies.delete(id);

      if (reply.result === undefined) throw new Error(`heap usage unavailable: ${reply.error?.message ?? 'no result'}`);

      return reply.result.usedSize;
    },
    close: () => socket.close(),
  };
}

const phases: Cut[] = [];

let measuring = false;

let currentText = '';

let driver: Awaited<ReturnType<Miniflare['getWorker']>>;

const workspace = `perf-${subject}`;

const inspectorPort = await freePort();

const wrangler = v.parse(BuiltConfigSchema, JSON.parse(readFileSync(join(dist, 'wrangler.json'), 'utf8')));

const compat = { compatibilityDate: wrangler.compatibility_date, compatibilityFlags: wrangler.compatibility_flags };

const key = btoa('worker-heap-credential-key-32byt');

const agent = buildAgentBundle(join(import.meta.dir, 'turn-file-io/facet.ts')).modules;

writeWhole(join(resolve(dist, wrangler.assets.directory), '_agent/modules.json'), JSON.stringify(agent));

const owner = await ownerCaller({ CREDENTIAL_ENCRYPTION_KEY: key });

if (!('ownerToken' in owner)) throw new Error('probe setup needs an owner caller');

async function ask(path: string, input?: JsonObject): Promise<string> {
  const init: DriverRequest = {};

  if (input !== undefined) { init.method = 'POST'; init.body = JSON.stringify(input); }

  const response = await driver.fetch(`http://driver.invalid${path}${path.includes('?') ? '&' : '?'}workspace=${workspace}`, init);
  const body = await response.text();

  if (!response.ok) throw new Error(`${path} returned ${String(response.status)}: ${body}`);

  return body;
}

async function model(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/models') return new Response(SCRIPTED_MODELS_BODY);

  if (url.hostname === 'models.dev') return new Response('{}', { headers: { 'content-type': 'application/json' } });

  if (url.hostname !== 'model.invalid') throw new Error(`probe refused network at ${request.url}`);
  const parsed = readScriptedRequest(await request.text());

  if ('refusal' in parsed) throw new Error(parsed.refusal.body);
  const asked = parsed.request;
  const [kind, deltasText = '0'] = currentText.split(':');
  const step = asked.turn.length;

  if (measuring && mode === 'counts' && asked.streamed) {
    phases.push(v.parse(CutSchema, JSON.parse(await ask(`/cut?label=${step === 0 ? 'open' : `step-${String(step)}`}&resume=1`))));
  }

  let answer: ScriptedAnswer = { text: 'Perf' };

  if (asked.streamed) {
    let tools = 0;

    if (kind === 'five') tools = 4;
    else if (kind === 'growth' || kind === 'long') tools = 1;
    answer = step < tools
      ? { toolCall: { name: 'file', arguments: { op: 'stat', path: '.' } } }
      : { text: kind === 'prior' || kind === 'long' ? Array.from({ length: Number(deltasText) }, (_, index) => `w${String(index)} `).join('') : 'ok' };
  }

  const out = scriptedBody(answer, asked);

  // The long-answer subject uses the same 500/2000 independent deltas as D23, not one artificial giant token.
  if (asked.streamed && answer.text !== undefined && (kind === 'prior' || kind === 'long')) {
    const prefix = { id: 'perf', object: 'chat.completion.chunk', model: 'fake-live', choices: [{ index: 0, delta: { role: 'assistant' } }] };
    const frames = [`data: ${JSON.stringify(prefix)}\n\n`];

    for (const word of answer.text.match(/\S+\s*/gu) ?? []) {
      frames.push(`data: ${JSON.stringify({ ...prefix, choices: [{ index: 0, delta: { content: word } }] })}\n\n`);
    }

    frames.push(`data: ${JSON.stringify({ ...prefix, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`, 'data: [DONE]\n\n');

    return new Response(frames.join(''), { headers: { 'content-type': out.contentType } });
  }

  return new Response(out.body, { headers: { 'content-type': out.contentType } });
}

const ai = await workersAiBinding(async (request) => workersAiAnswer(await readAiRun(request)));

const mf = new Miniflare(convertV4MiniflareOptions({
  inspectorPort,
  handleStructuredLogs: ({ level, message }) => { if (level === 'error') process.stderr.write(message + '\n'); },
  workers: [{
    name: 'kinu', ...compat, modulesRoot: dist, modules: await productModules(), workerLoaders: { LOADER: {} },
    bindings: { ...wrangler.vars, CREDENTIAL_ENCRYPTION_KEY: key, PERF_ISOLATED: isolated ? '1' : '0' }, ai,
    assets: { binding: wrangler.assets.binding, directory: resolve(dist, wrangler.assets.directory) },
    r2Buckets: wrangler.r2_buckets.map((bucket) => bucket.binding),
    kvNamespaces: wrangler.kv_namespaces.map((namespace) => namespace.binding),
    durableObjects: Object.fromEntries(wrangler.durable_objects.bindings.map((binding) => [binding.name, { className: binding.class_name, useSQLite: true }])),
    outboundService: model,
  }, {
    name: 'driver', ...compat,
    modules: [{ type: 'ESModule', path: join(dist, 'perf-driver.js'), contents: await bundle('driver.ts') }],
    bindings: { OWNER_TOKEN: owner.ownerToken },
    durableObjects: {
      PERF_DRIVER: { className: 'PerfDriver', useSQLite: true },
      OrchestratorAgent: { className: 'OrchestratorAgent', scriptName: 'kinu', useSQLite: true },
      UserDO: { className: 'UserDO', scriptName: 'kinu', useSQLite: true },
    },
  }],
}));

const inspectors = new Map<string, Inspector>();

const peaks = new Map<string, number>();

let sampling = false;

async function sampleHeap(): Promise<void> {
  const targets = v.parse(TargetsSchema, await (await fetch(`http://127.0.0.1:${String(inspectorPort)}/json`)).json());

  for (const target of targets.filter((entry) => entry.id.includes('kinu'))) {
    if (!inspectors.has(target.id)) inspectors.set(target.id, await connectInspector(target.webSocketDebuggerUrl));
  }

  for (const [id, inspector] of inspectors) peaks.set(id, Math.max(peaks.get(id) ?? 0, await inspector.heap()));
}

try {
  driver = await mf.getWorker('driver');
  await ask('/setup');
  const pid = workerdPid();
  const measured: object[] = [];

  const runTurn = async (text: string, record: boolean) => {
    currentText = text;
    phases.length = 0;

    if (record && mode === 'counts') await ask('/begin');
    measuring = record;
    const started = performance.now();
    const cpuBefore = cpu(pid);
    await ask(`/turn?text=${encodeURIComponent(text)}`);
    const elapsed = performance.now() - started;
    const spent = cpu(pid) - cpuBefore;
    measuring = false;

    if (record && mode === 'counts') phases.push(v.parse(CutSchema, JSON.parse(await ask('/cut?label=close&resume=0'))));

    if (record) {
      const result: TurnMeasurement = { text, wallMs: elapsed, cpuMs: spent };

      if (mode === 'counts') result.phases = [...phases];
      measured.push(result);
      process.stdout.write(JSON.stringify({ event: 'turn', sha, subject, mode, ...result }) + '\n');
    }
  };

  let samplingLoop: Promise<void> | undefined;

  if (mode === 'heap') {
    sampling = true;
    samplingLoop = (async () => {
      while (sampling) { await sampleHeap(); await Bun.sleep(5); }
    })();
  }

  if (subject === 'files') {
    await ask('/seed');
    const invoke = async (name: string, input: JsonObject) => await ask(`/tool?name=${name}`, input);
    const fileResults: object[] = [];

    const measureOp = async (label: string, operation: (index: number) => Promise<void>) => {
      await operation(-1);
      const walls: number[] = [];
      const cpus: number[] = [];

      for (let index = 0; index < samples; index++) {
        const before = cpu(pid);
        const started = performance.now();
        await operation(index);
        walls.push(performance.now() - started);
        cpus.push(cpu(pid) - before);
      }

      const quantile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
      const result = { label, samples, wallP50Ms: quantile(walls, 0.5), wallP95Ms: quantile(walls, 0.95), cpuP50Ms: quantile(cpus, 0.5), cpuP95Ms: quantile(cpus, 0.95), cpuMeanMs: cpus.reduce((a, b) => a + b, 0) / samples };
      fileResults.push(result);
      process.stdout.write(JSON.stringify({ event: 'file', sha, ...result }) + '\n');
    };

    for (const bytes of [4096, 65536, 1048576]) {
      const path = `/home/perfio/read-${String(bytes)}.txt`;
      await measureOp(`file.read.${String(bytes)}`, async () => { await invoke('file', { op: 'read', path }); });
      await measureOp(`shell.read.${String(bytes)}`, async () => { await invoke('shell', { command: `cat ${path}`, runtime: 'workspace' }); });
      const content = 'x'.repeat(bytes);
      await measureOp(`file.write.${String(bytes)}`, async (index) => { await invoke('file', { op: 'write', path: `/home/perfio/fw-${String(bytes)}-${String(index)}.txt`, content }); });
      await measureOp(`shell.write.${String(bytes)}`, async (index) => {
        await invoke('shell', { command: `head -c ${String(bytes)} /dev/zero > /home/perfio/sw-${String(bytes)}-${String(index)}.bin`, runtime: 'workspace' });
      });
    }

    await measureOp('file.stat', async () => { await invoke('file', { op: 'stat', path: '/home/perfio/read-4096.txt' }); });
    await measureOp('shell.stat', async () => { await invoke('shell', { command: 'stat /home/perfio/read-4096.txt', runtime: 'workspace' }); });
    await measureOp('file.list500', async () => { await invoke('file', { op: 'list', path: '/home/perfio/many' }); });
    await measureOp('shell.list500', async () => { await invoke('shell', { command: 'ls /home/perfio/many', runtime: 'workspace' }); });
    await measureOp('shell.search500', async () => { await invoke('shell', { command: 'grep -r -l needle /home/perfio/many', runtime: 'workspace' }); });
    await measureOp('file.search500', async () => {
      for (let at = 0; at < 500; at++) await invoke('file', { op: 'search', path: `/home/perfio/many/f${String(at).padStart(3, '0')}.txt`, query: 'needle' });
    });
    await measureOp('file.edit', async (index) => {
      const path = '/home/perfio/edit.txt';
      await invoke('file', { op: 'read', path });
      const old = index % 2 === 0 ? 'anchor-b' : 'anchor-a';
      await invoke('file', { op: 'edit', path, edits: [{ old_text: old, new_text: old === 'anchor-a' ? 'anchor-b' : 'anchor-a' }] });
    });
    await measureOp('shell.edit', async () => {
      await invoke('shell', { command: "sed -i 's/anchor/ANCHOR/' /home/perfio/edit.txt", runtime: 'workspace' });
    });
    measured.push(...fileResults);
  } else if (subject === 'growth') {
    for (let turn = 1; turn <= 300; turn++) await runTurn(`growth:${String(turn)}`, [1, 50, 300].includes(turn));
  } else {
    if (subject === 'long') for (let turn = 0; turn < 20; turn++) await runTurn('prior:2000', false);
    await runTurn(subject === 'long' ? 'long:500' : subject, true);
  }

  sampling = false;
  await samplingLoop;
  process.stdout.write(JSON.stringify({ event: 'measurement', sha, subject, mode, isolated, workerdPid: pid, cpuMethod: 'sum Linux per-thread schedstat runtime, ms', heapSamplingMs: mode === 'heap' ? 5 : null, peaks: Object.fromEntries(peaks), measured }) + '\n');
} finally {
  sampling = false;

  for (const inspector of inspectors.values()) inspector.close();
  await mf.dispose();
}
