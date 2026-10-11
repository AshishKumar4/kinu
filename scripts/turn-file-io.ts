/** Exact-built-bundle workerd measurements. Run only on armada; model inference is a zero-delay script outside workerd. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { createServer } from 'node:net';
import { build } from 'esbuild';
import { nodeRequireAsImport } from '../packages/cf-backend/esbuild-node-require';
import { Miniflare, Response as MiniflareResponse, WebSocketPair, convertV4MiniflareOptions } from 'miniflare';
import { PERF_SECRET, PERF_SECRET_HOST } from './turn-file-io/egress-secret';
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

const COMMAND_HOSTS: readonly string[] = ['github.com', 'codeload.github.com', 'registry.npmjs.org', 'example.com'];

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

interface StepMeasurement { readonly label: string; readonly wallMs: number; readonly cpuMs: number }

interface TurnMeasurement {
  readonly text: string; readonly wallMs: number; readonly cpuMs: number;
  readonly modelSteps: number; phases?: Cut[]; timings?: StepMeasurement[]; peaks?: Record<string, number>;
  stepPeaks?: Record<string, Record<string, number>>;
}

interface DriverRequest { method?: string; body?: string }

async function bundle(file: string): Promise<string> {
  const result = await build({
    entryPoints: [join(import.meta.dir, 'turn-file-io', file)], bundle: true, write: false, format: 'esm',
    platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
    alias: Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, `node:${name}`])),
    external: ['cloudflare:*', 'node:*'], plugins: [nodeRequireAsImport, { name: 'product', setup: (plugin) => {
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
  /** Starts sampling this isolate's CPU; `stop` answers the profile. */
  profile(): Promise<{ stop: () => Promise<CpuProfile> }>;
  close(): void;
}

const CpuProfileSchema = v.object({
  nodes: v.array(v.object({
    id: v.number(), callFrame: v.object({ functionName: v.string(), url: v.string(), lineNumber: v.number() }), children: v.optional(v.array(v.number())),
  })),
  samples: v.array(v.number()),
  timeDeltas: v.array(v.number()),
});

type CpuProfile = v.InferOutput<typeof CpuProfileSchema>;

const frameName = (frame: CpuProfile['nodes'][number]['callFrame']): string => `${frame.functionName || '(anon)'} ${frame.url.split('/').slice(-1)[0] ?? ''}:${String(frame.lineNumber)}`;

/** Each function's time on the stack, itself or its callees, most first, counted once per sample however deep it recurs. */
function inclusiveTimes(profile: CpuProfile): Array<[string, number]> {
  const parent = new Map<number, number>();

  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const byNode = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, number>();

  for (const [index, sample] of profile.samples.entries()) {
    const seen = new Set<string>();

    for (let at: number | undefined = sample; at !== undefined; at = parent.get(at)) {
      const node = byNode.get(at);

      if (node !== undefined) seen.add(frameName(node.callFrame));
    }

    for (const name of seen) totals.set(name, (totals.get(name) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000);
  }

  return [...totals].sort((left, right) => right[1] - left[1]);
}

/** Each function's own sampled time, most first: `name url-tail:line` and milliseconds. */
function selfTimes(profile: CpuProfile): Array<[string, number]> {
  const byNode = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, number>();

  for (const [index, sample] of profile.samples.entries()) {
    const frame = byNode.get(sample)?.callFrame;
    const key = frame === undefined ? '?' : frameName(frame);

    totals.set(key, (totals.get(key) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000);
  }

  return [...totals].sort((left, right) => right[1] - left[1]);
}

async function connectInspector(url: string): Promise<Inspector> {
  const socket = new WebSocket(url);
  const opened = Promise.withResolvers<void>();
  const replies = new Map<number, (reply: HeapReply) => void>();
  let id = 0;
  socket.addEventListener('open', () => { opened.resolve(); });
  socket.addEventListener('error', () => opened.reject(new Error(`inspector failed: ${url}`)));
  const raw = new Map<number, (reply: string) => void>();

  socket.addEventListener('message', (event) => {
    const message: unknown = JSON.parse(String(event.data));
    const answered = v.safeParse(v.object({ id: v.number() }), message);

    if (answered.success && raw.has(answered.output.id)) {
      raw.get(answered.output.id)?.(String(event.data));
      raw.delete(answered.output.id);

      return;
    }

    const parsed = v.safeParse(HeapReplySchema, message);

    if (!parsed.success) return;
    const reply = parsed.output;

    if (reply.id !== undefined) replies.get(reply.id)?.(reply);
  });
  await opened.promise;

  /** The protocol's answer to `method`, as its JSON text. */
  const call = async (method: string, params: Readonly<Record<string, number>> = {}): Promise<string> => {
    const pending = Promise.withResolvers<string>();
    const requestId = ++id;

    raw.set(requestId, pending.resolve);
    socket.send(JSON.stringify({ id: requestId, method, params }));

    return await pending.promise;
  };

  return {
    profile: async () => {
      await call('Profiler.enable');
      await call('Profiler.setSamplingInterval', { interval: 50 });
      await call('Profiler.start');

      return { stop: async () => v.parse(v.object({ result: v.object({ profile: CpuProfileSchema }) }), JSON.parse(await call('Profiler.stop'))).result.profile };
    },
    heap: async () => {
      const pending = Promise.withResolvers<HeapReply>();
      const requestId = ++id;
      replies.set(requestId, pending.resolve);
      socket.send(JSON.stringify({ id: requestId, method: 'Runtime.getHeapUsage' }));
      const reply = await pending.promise;
      replies.delete(requestId);

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

let enginePid = 0;

let phaseWall = 0;

let phaseCpu = 0;

let modelWall = 0;

let modelStep = 0;

let phaseExcluded = 0;

const stepTimings: StepMeasurement[] = [];

const workspace = `perf-${subject}`;

const inspectorPort = await freePort();

const wrangler = v.parse(BuiltConfigSchema, JSON.parse(readFileSync(join(dist, 'wrangler.json'), 'utf8')));

const compat = { compatibilityDate: wrangler.compatibility_date, compatibilityFlags: wrangler.compatibility_flags };

const key = btoa('worker-heap-credential-key-32byt');

const agent = (await buildAgentBundle(join(import.meta.dir, 'turn-file-io/facet.ts'))).modules;

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

/** A bare repository the egress subject pushes to, served as git's smart HTTP by `git http-backend`. */
const gitRoot = join(process.env.TMPDIR ?? '/tmp', `perfio-git-${String(process.pid)}`);

/**
 * `git.perfio.test`, the host the probe's secret is bound to: `/echo` and `/ws` reflect the Authorization they were sent,
 * and `/repo.git` is served by `git http-backend`.
 */
async function gitServer(request: Request): Promise<Response | MiniflareResponse> {
  const url = new URL(request.url);

  const authorization = request.headers.get('authorization') ?? 'none';

  // Reflects the Authorization it was sent, and says whether that was the secret: the program must read the placeholder.
  if (url.pathname === '/echo') return new Response(`auth=${authorization}\nsecret=${String(authorization === `Bearer ${PERF_SECRET}`)}\n`);

  if (url.pathname === '/ws') return reflectingSocket(authorization);

  const env = {
    GIT_PROJECT_ROOT: gitRoot, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'perfio', REQUEST_METHOD: request.method, PATH_INFO: url.pathname,
    QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get('content-type') ?? '', PATH: process.env.PATH ?? '',
    HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
  };

  const ran = Bun.spawn(['git', 'http-backend'], { env, stdin: new Uint8Array(await request.arrayBuffer()), stdout: 'pipe', stderr: 'pipe' });
  const out = new Uint8Array(await new Response(ran.stdout).arrayBuffer());
  const split = Buffer.from(out).indexOf('\r\n\r\n');

  const headers = new Headers();
  let status = 200;

  for (const line of new TextDecoder().decode(out.subarray(0, split)).split('\r\n')) {
    const [name = '', ...rest] = line.split(':');

    if (name.toLowerCase() === 'status') status = Number.parseInt(rest.join(':').trim(), 10);
    else headers.set(name, rest.join(':').trim());
  }

  return new Response(out.subarray(split + 4), { status, headers });
}

/** A WebSocket that opens by sending the Authorization its upgrade carried, then echoes, as a server leaking it would. */
function reflectingSocket(authorization: string): MiniflareResponse {
  const [client, server] = Object.values(new WebSocketPair());

  server.accept();
  server.send(`auth=${authorization}`);
  server.addEventListener('message', (event) => { server.send(event.data); });

  return new MiniflareResponse(null, { status: 101, webSocket: client });
}

/** `echo.perfio.test`: a WebSocket server that answers each message with itself, as a public echo server does. */
function echoSocket(request: Request): MiniflareResponse {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new MiniflareResponse('a WebSocket echo', { status: 426 });
  const [client, server] = Object.values(new WebSocketPair());

  server.accept();
  server.addEventListener('message', (event) => { server.send(event.data); });

  return new MiniflareResponse(null, { status: 101, webSocket: client });
}

/** `request` answered by the network; Bun's fetch decodes the body and keeps its content-encoding, which workerd would decode again. */
async function passedThrough(request: Request): Promise<Response> {
  const fetched = await fetch(request);
  const headers = new Headers(fetched.headers);

  headers.delete('content-encoding');
  headers.delete('content-length');

  return new Response(fetched.body, { status: fetched.status, statusText: fetched.statusText, headers });
}

/** A streamed step's answer for the current prompt kind: its file tool calls first, then its text. */
function streamedAnswer(kind: string | undefined, step: number, deltas: number): ScriptedAnswer {
  let tools = 0;

  if (kind === 'five') tools = 4;
  else if (kind === 'growth') tools = 1;

  if (step < tools) {
    return { toolCall: { name: 'file', arguments: kind === 'five'
      ? { op: 'write', path: `notes/perfio-step-${String(step)}.txt`, content: `note ${String(step)}` }
      : { op: 'stat', path: '.' } } };
  }

  return { text: kind === 'prior' || kind === 'long' ? Array.from({ length: deltas }, (_, index) => `w${String(index)} `).join('') : 'ok' };
}

/** What a measured step costs up to the model's call: its time, its heap or its counts, as the mode asks. */
async function measureStep(step: number, entered: number, consumed: number): Promise<void> {
  const label = step === 0 ? 'open' : `step-${String(step)}`;

  if (mode === 'time') stepTimings.push({ label, wallMs: entered - phaseWall - phaseExcluded, cpuMs: consumed - phaseCpu });

  if (mode === 'heap') await sampleHeap();

  if (mode === 'counts') phases.push(v.parse(CutSchema, JSON.parse(await ask(`/cut?label=${label}&resume=1`))));
}

async function model(request: Request): Promise<Response | MiniflareResponse> {
  const entered = performance.now();
  const consumed = measuring ? cpu(enginePid) : 0;
  const url = new URL(request.url);

  // Only the commands and egress subjects reach the network: their clone and install are what they measure.
  if ((subject === 'commands' || subject === 'egress') && COMMAND_HOSTS.includes(url.hostname)) return await passedThrough(request);

  if (subject === 'egress' && url.hostname === PERF_SECRET_HOST) return await gitServer(request);

  if (subject === 'egress' && url.hostname === 'echo.perfio.test') return echoSocket(request);

  if (url.pathname === '/models') return new Response(SCRIPTED_MODELS_BODY);

  if (url.hostname === 'models.dev') return new Response('{}', { headers: { 'content-type': 'application/json' } });

  if (url.hostname !== 'model.invalid') throw new Error(`probe refused network at ${request.url}`);
  const parsed = readScriptedRequest(await request.text());

  if ('refusal' in parsed) throw new Error(parsed.refusal.body);
  const asked = parsed.request;
  const [kind, deltasText = '0'] = currentText.split(':');
  const step = asked.streamed ? modelStep++ : 0;

  if (measuring && asked.streamed) await measureStep(step, entered, consumed);

  const answer: ScriptedAnswer = asked.streamed ? streamedAnswer(kind, step, Number(deltasText)) : { text: 'Perf' };
  const out = scriptedBody(answer, asked);

  // The long-answer subject uses the same 500/2000 independent deltas as D23, not one artificial giant token.
  if (asked.streamed && answer.text !== undefined && (kind === 'prior' || kind === 'long')) {
    const prefix = { id: 'perf', object: 'chat.completion.chunk', model: 'fake-live', choices: [{ index: 0, delta: { role: 'assistant' } }] };
    const frames = [`data: ${JSON.stringify(prefix)}\n\n`];

    for (const word of answer.text.match(/\S+\s*/gu) ?? []) {
      frames.push(`data: ${JSON.stringify({ ...prefix, choices: [{ index: 0, delta: { content: word } }] })}\n\n`);
    }

    frames.push(`data: ${JSON.stringify({ ...prefix, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`, 'data: [DONE]\n\n');

    const reply = new Response(frames.join(''), { headers: { 'content-type': out.contentType } });
    modelFinished(entered, asked.streamed);

    return reply;
  }

  const reply = new Response(out.body, { headers: { 'content-type': out.contentType } });
  modelFinished(entered, asked.streamed);

  return reply;
}

function modelFinished(entered: number, streamed: boolean): void {
  const finished = performance.now();

  if (measuring) {
    modelWall += finished - entered;
    phaseExcluded += finished - entered;

    if (streamed) {
      phaseWall = finished;
      phaseCpu = cpu(enginePid);
      phaseExcluded = 0;
      heapPhase = `step-${String(modelStep)}`;
    }
  }
}

const ai = await workersAiBinding(async (request) => workersAiAnswer(await readAiRun(request)));

const product = {
  name: 'kinu', ...compat, modulesRoot: dist, modules: await productModules(), workerLoaders: { LOADER: {} },
  bindings: { ...wrangler.vars, CREDENTIAL_ENCRYPTION_KEY: key, PERF_ISOLATED: isolated ? '1' : '0' }, ai,
  assets: { binding: wrangler.assets.binding, directory: resolve(dist, wrangler.assets.directory) },
  r2Buckets: wrangler.r2_buckets.map((bucket) => bucket.binding),
  kvNamespaces: wrangler.kv_namespaces.map((namespace) => namespace.binding),
  durableObjects: Object.fromEntries(wrangler.durable_objects.bindings.map((binding) => [binding.name, { className: binding.class_name, useSQLite: true }])),
  outboundService: model,
};

const mf = new Miniflare(convertV4MiniflareOptions({
  inspectorPort,
  handleStructuredLogs: ({ level, message }) => { if (level === 'error') process.stderr.write(message + '\n'); },
  workers: [product, {
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

const stepPeaks = new Map<string, Map<string, number>>();

let heapPhase = 'open';

let sampling = false;

let heapRead = Promise.resolve();

async function sampleHeap(): Promise<void> {
  heapRead = heapRead.then(readHeap);
  await heapRead;
}

async function readHeap(): Promise<void> {
  const targets = v.parse(TargetsSchema, await (await fetch(`http://127.0.0.1:${String(inspectorPort)}/json`)).json());

  for (const target of targets.filter((entry) => entry.id.includes('kinu'))) {
    if (!inspectors.has(target.id)) inspectors.set(target.id, await connectInspector(target.webSocketDebuggerUrl));
  }

  for (const [id, inspector] of inspectors) {
    const used = await inspector.heap();
    peaks.set(id, Math.max(peaks.get(id) ?? 0, used));
    const held = stepPeaks.get(heapPhase) ?? new Map<string, number>();
    held.set(id, Math.max(held.get(id) ?? 0, used));
    stepPeaks.set(heapPhase, held);
  }
}

/** `run` again under a CPU profile of every isolate it touches; the product's are printed. */
async function profiled(workload: string, run: () => Promise<void>): Promise<void> {
  // Every isolate the run touched, facets' included, not only the product's.
  const targets = v.parse(TargetsSchema, await (await fetch(`http://127.0.0.1:${String(inspectorPort)}/json`)).json());

  for (const target of targets) if (!inspectors.has(target.id)) inspectors.set(target.id, await connectInspector(target.webSocketDebuggerUrl));
  const running = await Promise.all([...inspectors].map(async ([id, inspector]) => ({ id, profiler: await inspector.profile() })));
  const started = performance.now();

  await run();
  const wall = performance.now() - started;

  // The product's isolates only: the driver and Miniflare's entry are this harness's.
  const keep = option('profile-dir', '');

  for (const { id, profiler } of running) {
    const profile = await profiler.stop();

    if (keep !== '') writeFileSync(join(keep, `${workload}-${id.replace(/[^a-z0-9-]/gi, '_')}.cpuprofile`), JSON.stringify(profile));
    const ranked = selfTimes(profile);
    const busy = ranked.filter(([name]) => !name.startsWith('(idle)')).reduce((sum, [, ms]) => sum + ms, 0);

    if (!id.includes('kinu') && !id.includes('facet') && !id.includes('loader')) continue;
    process.stdout.write(`PROFILE ${workload} ${id.slice(-24)} wall=${wall.toFixed(0)}ms busy=${busy.toFixed(0)}ms\n`);

    for (const [name, ms] of ranked.slice(0, 15)) process.stdout.write(`  self ${ms.toFixed(1).padStart(7)} ${name.slice(0, 70)}\n`);

    for (const [name, ms] of inclusiveTimes(profile).slice(0, 24)) process.stdout.write(`  incl ${ms.toFixed(1).padStart(7)} ${name.slice(0, 70)}\n`);
  }

  process.stdout.write(`TARGETS ${running.map(({ id }) => id.slice(-24)).join(' | ')}\n`);
}

try {
  driver = await mf.getWorker('driver');
  await ask('/setup');
  const pid = workerdPid();
  enginePid = pid;
  const measured: object[] = [];

  const runTurn = async (text: string, record: boolean) => {
    currentText = text;
    phases.length = 0;
    stepTimings.length = 0;
    modelWall = 0;
    modelStep = 0;
    phaseExcluded = 0;
    heapPhase = 'open';
    stepPeaks.clear();

    if (record && mode === 'heap') { peaks.clear(); await sampleHeap(); }

    if (record && mode === 'counts') await ask('/begin');
    measuring = record;
    const started = performance.now();
    const cpuBefore = cpu(pid);
    phaseWall = started;
    phaseCpu = cpuBefore;
    await ask(`/turn?text=${encodeURIComponent(text)}`);
    const finished = performance.now();
    const elapsed = finished - started - modelWall;
    const spent = cpu(pid) - cpuBefore;

    if (record && mode === 'time') stepTimings.push({ label: 'close', wallMs: finished - phaseWall - phaseExcluded, cpuMs: cpu(pid) - phaseCpu });

    if (record && mode === 'heap') {
      heapPhase = `step-${String(modelStep)}`;
      await sampleHeap();
    }

    measuring = false;

    if (record && mode === 'counts') phases.push(v.parse(CutSchema, JSON.parse(await ask('/cut?label=close&resume=0'))));

    if (record) {
      const result: TurnMeasurement = { text, wallMs: elapsed, cpuMs: spent, modelSteps: modelStep };

      if (mode === 'counts') result.phases = [...phases];

      if (mode === 'time') result.timings = [...stepTimings];

      if (mode === 'heap') {
        result.peaks = Object.fromEntries(peaks);
        result.stepPeaks = Object.fromEntries([...stepPeaks].map(([phase, held]) => [phase, Object.fromEntries(held)]));
      }

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

  const invoke = async (name: string, input: JsonObject) => await ask(`/tool?name=${name}`, input);

  const fileResults: object[] = [];

  /**
   * `expect` counts the samples whose tool answer holds the command's correct output; a failed call counts as
   * incorrect, and the warm-up's wrong answer is printed so a red count names its cause.
   */
  const measureOp = async (label: string, operation: (index: number) => Promise<string | void>, prepare?: () => Promise<void>, expect?: string) => {
    const answered = async (index: number) => {
      try {
        return await operation(index);
      } catch (error) {
        return `failed: ${String(error)}`;
      }
    };

    await prepare?.();
    const warm = await answered(-1);

    if (expect !== undefined && !(typeof warm === 'string' && warm.includes(expect))) {
      process.stdout.write(JSON.stringify({ event: 'file.unexpected', sha, label, answer: String(warm).slice(-1200) }) + '\n');
    }

    const walls: number[] = [];
    const cpus: number[] = [];
    let correct = 0;

    for (let index = 0; index < samples; index++) {
      await prepare?.();

      const before = cpu(pid);
      const started = performance.now();
      const answer = await answered(index);
      walls.push(performance.now() - started);
      cpus.push(cpu(pid) - before);

      if (expect !== undefined && typeof answer === 'string' && answer.includes(expect)) correct++;
    }

    const quantile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

    const result = {
      label, samples, wallP50Ms: quantile(walls, 0.5), wallP95Ms: quantile(walls, 0.95), cpuP50Ms: quantile(cpus, 0.5), cpuP95Ms: quantile(cpus, 0.95),
      cpuMeanMs: cpus.reduce((a, b) => a + b, 0) / samples, ...(expect !== undefined && { correct }),
    };

    fileResults.push(result);
    process.stdout.write(JSON.stringify({ event: 'file', sha, ...result }) + '\n');
  };

  const shell = async (command: string) => await invoke('shell', { command, runtime: 'workspace' });

  const node = (program: string) => `node -e ${JSON.stringify(program)}`;

  if (subject === 'profile') {
    await ask('/seed');
    const workload = option('profile', 'file');

    const workloads = {
      node: async () => { for (let index = 0; index < 20; index++) await shell(node("process.stdout.write('x')")); },
      grep: async () => { for (let index = 0; index < 20; index++) await shell('grep -r -l needle /home/main/perfio/many'); },
      stat: async () => { for (let index = 0; index < 200; index++) await shell('stat /home/main/perfio/read-4096.txt'); },
      file: async () => { for (let index = 0; index < 200; index++) await invoke('file', { op: 'read', path: '/home/main/perfio/read-4096.txt' }); },
    } satisfies Record<string, () => Promise<void>>;

    const run = workload === 'node' || workload === 'grep' || workload === 'stat' ? workloads[workload] : workloads.file;

    await run();

    // Only the run, twice: what the product logs of it is the measurement.
    if (option('cpu', '1') === '0') await run();
    else await profiled(workload, run);

    measured.push(...fileResults);
  } else if (subject === 'egress') {
    await ask('/seed');
    // The engine boots, and its egress is minted, before the secret is granted: a grant made later is still spent.
    await shell('true');
    const placeholder = await ask('/grant');

    Bun.spawnSync(['git', 'init', '-q', '--bare', join(gitRoot, 'repo.git')]);
    Bun.spawnSync(['git', '-C', join(gitRoot, 'repo.git'), 'config', 'http.receivepack', 'true']);

    // Every command's network is the workspace egress's: its destination check, its vault, its scrub.
    await measureOp('egress.curl', () => shell("curl -sS https://example.com/ | grep -o 'Example Domain' | head -1 | sed 's/^/page=/'"), undefined, 'page=Example Domain');
    await measureOp('egress.clone', (index) => {
      const at = `/home/main/perfio/eclone-${String(index + 1)}`;

      return shell(`git clone --depth 1 https://github.com/expressjs/express ${at} && ${node(`console.log('name=' + require('${at}/package.json').name)`)}`);
    }, undefined, 'name=express');
    await measureOp('egress.push', (index) => {
      const at = `/home/main/perfio/epush-${String(index + 2)}`;

      const branch = `b${String(index + 2)}`;

      return shell(`mkdir -p ${at} && cd ${at} && git init -q && git config user.email p@perfio.test && git config user.name perfio`
        + ` && echo ${String(index)} > a.txt && git add a.txt && git commit -q -m ${branch} && git branch ${branch}`
        + ` && git remote add origin https://${PERF_SECRET_HOST}/repo.git && git push origin ${branch} && echo pushed=${branch}`);
    }, undefined, 'pushed=b');
    // The server gets the secret; the program reads its echo with the placeholder back in its place.
    const inject = () => shell(`curl -sS -H "Authorization: Bearer ${placeholder}" https://${PERF_SECRET_HOST}/echo`);

    const wsInject = (at: string) => shell(`mkdir -p ${at} && cd ${at} && echo '{"name":"probe","private":true}' > package.json`
      + ` && npm install --no-audit --no-fund ws@8 > /dev/null && ${node([
        `const w = new (require('ws'))('wss://${PERF_SECRET_HOST}/ws', { headers: { Authorization: 'Bearer ${placeholder}' } });`,
        "w.on('message', (d) => { console.log('ws ' + d); w.close(); }); w.on('error', (e) => console.log('ws failed: ' + e.message));",
      ].join(' '))}`);

    await measureOp('egress.inject', inject, undefined, `auth=Bearer ${placeholder}\nsecret=true`);
    await measureOp('egress.wsinject', (index) => wsInject(`/home/main/perfio/ews-${String(index + 2)}`), undefined, `ws auth=Bearer ${placeholder}`);
    await measureOp('egress.npm', (index) => {
      const at = `/home/main/perfio/enpm-${String(index + 2)}`;

      return shell(`mkdir -p ${at} && cd ${at} && echo '{"name":"probe","private":true}' > package.json`
        + ` && npm install --no-audit --no-fund ms@2.1.3 && ${node("console.log('ms=' + require('ms/package.json').version)")}`);
    }, undefined, 'ms=2.1.3');
    await measureOp('egress.tls', () => shell(node(
      "const s = require('tls').connect(443, 'example.com', () => s.write('HEAD / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n')); s.on('data', (d) => { console.log('tls=' + String(d).split(' ')[0]); s.destroy(); }); s.on('error', (e) => console.log('tls failed: ' + e.message))",
    )), undefined, 'tls=HTTP/1');
    await measureOp('egress.wss', () => shell(node(
      "const w = new WebSocket('wss://echo.perfio.test/'); w.onopen = () => w.send('kinu-ws'); w.onmessage = (e) => { if (String(e.data) === 'kinu-ws') { console.log('ws=echoed'); w.close(); } }; w.onerror = (e) => console.log('ws failed: ' + (e.message ?? 'error'))",
    )), undefined, 'ws=echoed');
    await measureOp('egress.upgrade', () => shell(node(
      "require('https').request({ host: 'echo.perfio.test', path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } }).on('upgrade', (res, socket) => { console.log('upgrade=' + res.statusCode); socket.destroy(); }).on('response', (res) => console.log('upgrade failed: ' + res.statusCode)).on('error', (e) => console.log('upgrade failed: ' + e.message)).end()",
    )), undefined, 'upgrade=101');
    await measureOp('egress.clientcert', () => shell(node(
      "try { const s = require('tls').connect({ host: 'example.com', port: 443, cert: 'c', key: 'k' }, () => { console.log('clientcert=connected'); s.destroy(); }); s.on('error', (e) => console.log('clientcert=' + (e.code ?? e.message))); } catch (e) { console.log('clientcert=' + (e.code ?? e.message)); }",
    )), undefined, 'clientcert=connected');

    // The egress's own refusal names the address; the isolate's network would time out or reset without one.
    await measureOp('egress.private', () => shell('curl -sS --max-time 5 http://10.0.0.1/'), undefined, 'blocked');
    const seen = `${await inject()}\n${await wsInject('/home/main/perfio/ews-leak')}`;

    process.stdout.write(`SECRET-LEAK ${String(seen.includes(PERF_SECRET))} placeholder-seen ${String(seen.includes(placeholder))}\n`);
    measured.push(...fileResults);
  } else if (subject === 'abort') {
    // A busy command aborted as a Stop aborts it: once the call settles, nothing of it may still burn the engine's CPU.
    await ask('/seed');

    const share = async (ms: number) => {
      const before = cpu(pid);

      await Bun.sleep(ms);

      return (cpu(pid) - before) / ms;
    };

    const idle = await share(3000);

    const loops = [
      { label: 'abort.bash', command: 'bash -c "while :; do :; done"' },
      { label: 'abort.yield', command: node('setInterval(() => { for (let i = 0; i < 1e7; i++); }, 0)') },
      // Never yields: it holds its isolate's thread, the host's abort timer too, until a CPU limit ends it (ask 41).
      { label: 'abort.node', command: node('for (;;) {}') },
      { label: 'abort.pipe', command: `${node('for (;;) {}')} | cat` },
    ];

    for (const loop of loops) {
      const started = performance.now();
      let answer: string;

      try {
        answer = await ask('/tool?name=shell&abortAfterMs=1500', { command: loop.command, runtime: 'workspace' });
      } catch (error) {
        answer = `threw: ${String(error)}`;
      }

      const settledMs = performance.now() - started;
      const after = await share(3000);

      process.stdout.write(JSON.stringify({ event: 'abort', sha, label: loop.label, settledMs, idleShare: idle, cpuShareAfter: after, answer: answer.slice(-300) }) + '\n');
    }
  } else if (subject === 'boot') {
    // A workspace's cold open: set up fresh (an owner, a credential), then its first command, which boots its engine.
    const fresh = async (name: string, path: string, input?: JsonObject): Promise<string> => {
      const response = await driver.fetch(`http://driver.invalid${path}${path.includes('?') ? '&' : '?'}workspace=${name}`, input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) });
      const body = await response.text();

      if (!response.ok) throw new Error(`${path} returned ${String(response.status)}: ${body}`);

      return body;
    };

    for (let index = 0; index < samples; index++) {
      const name = `boot-${String(index)}`;
      const started = performance.now();

      await fresh(name, '/setup');
      const setUp = performance.now();
      const answer = await fresh(name, '/tool?name=shell', { command: 'echo booted', runtime: 'workspace' });

      process.stdout.write(JSON.stringify({ event: 'boot', sha, setupMs: setUp - started, firstCommandMs: performance.now() - setUp, ok: answer.includes('booted') }) + '\n');
    }
  } else if (subject === 'pipes') {
    await ask('/seed');

    // A process's output through a pipe, by how many writes carry it, and as an agent's `npm test | tail` reads it.
    for (const lines of [2_000, 20_000, 200_000]) {
      const program = node(`for (let i = 0; i < ${String(lines)}; i++) console.log(i)`);

      await measureOp(`pipe.tail.${String(lines)}`, () => shell(`${program} | tail -1 | sed 's/^/last=/'`), undefined, `last=${String(lines - 1)}`);
      // Every line holding a 1, so a lost write anywhere in the stream shows as a wrong count.
      const ones = Array.from({ length: lines }, (_, index) => String(index)).filter((line) => line.includes('1')).length;

      await measureOp(`pipe.grep.${String(lines)}`, () => shell(`${program} | grep -c 1 | sed 's/^/count=/'`), undefined, `count=${String(ones)}\n`);
      await measureOp(`pipe.head.${String(lines)}`, () => shell(`${program} | head -1 | sed 's/^/first=/'`), undefined, 'first=0');
    }

    const project = '/home/main/perfio/tested';
    const tests = "for (let i = 0; i < 3000; i++) console.log('ok ' + (i + 1) + ' - case ' + i); console.log('# pass ' + 3000)";

    await shell(`mkdir -p ${project} && cd ${project} && echo '{"name":"tested","private":true,"scripts":{"test":"node test.js"}}' > package.json && echo ${JSON.stringify(tests)} > test.js`);
    await measureOp('pipe.npmtest', () => shell(`cd ${project} && npm test 2>&1 | tail -20`), undefined, '# pass 3000');
    measured.push(...fileResults);
  } else if (subject === 'commands') {
    await ask('/seed');
    // An expected answer is what only the command's own run prints: a byte count, a line, an exit status, a package's name.

    await measureOp('process.out1m', () => shell(`${node("process.stdout.write('x'.repeat(1 << 20))")} | wc -c`), undefined, '1048576');
    await measureOp('process.utf8.200k', () => shell(`${node("process.stdout.write('\\u00e9'.repeat(100000))")} | wc -c`), undefined, '200000');
    await measureOp('process.pipe200k', () => shell(`${node('for (let i = 0; i < 200000; i++) console.log(i)')} | tail -1`), undefined, '199999');
    await measureOp('process.stdin1m', () => shell(
      `head -c 1048576 /dev/zero | ${node("let n = 0; process.stdin.on('data', (d) => { n += d.length; }).on('end', () => console.log('read=' + n))")}`,
    ), undefined, 'read=1048576');
    await measureOp('process.throws', () => shell(`${node("throw new Error('probe')")}; echo "exit=$?"`), undefined, 'exit=1');
    await measureOp('git.clone', (index) => {
      const at = `/home/main/perfio/clone-${String(index + 1)}`;

      return shell(`git clone --depth 1 https://github.com/expressjs/express ${at} && ${node(`console.log('name=' + require('${at}/package.json').name)`)}`);
    }, undefined, 'name=express');
    await measureOp('npm.install', (index) => {
      const at = `/home/main/perfio/npm-${String(index + 1)}`;

      return shell(`mkdir -p ${at} && cd ${at} && echo '{"name":"probe","private":true}' > package.json`
        + ` && npm install --no-audit --no-fund express@4.21.2 && ${node("console.log('express=' + require('express/package.json').version)")}`);
    }, undefined, 'express=4.21.2');
    measured.push(...fileResults);
  } else if (subject === 'files') {
    await ask('/seed');

    for (const bytes of [4096, 65536, 1048576]) {
      const path = `/home/main/perfio/read-${String(bytes)}.txt`;
      await measureOp(`file.read.${String(bytes)}`, async () => { await invoke('file', { op: 'read', path }); });
      await measureOp(`shell.read.${String(bytes)}`, async () => { await invoke('shell', { command: `cat ${path}`, runtime: 'workspace' }); });
      const content = 'x'.repeat(bytes);
      await measureOp(`file.write.${String(bytes)}`, async (index) => { await invoke('file', { op: 'write', path: `/home/main/perfio/fw-${String(bytes)}-${String(index)}.txt`, content }); });
      await measureOp(`shell.write.${String(bytes)}`, async (index) => {
        await invoke('shell', { command: `head -c ${String(bytes)} /dev/zero > /home/main/perfio/sw-${String(bytes)}-${String(index)}.bin`, runtime: 'workspace' });
      });
    }

    await measureOp('file.stat', async () => { await invoke('file', { op: 'stat', path: '/home/main/perfio/read-4096.txt' }); });
    await measureOp('shell.stat', async () => { await invoke('shell', { command: 'stat /home/main/perfio/read-4096.txt', runtime: 'workspace' }); });
    await measureOp('file.list500', async () => { await invoke('file', { op: 'list', path: '/home/main/perfio/many' }); });
    await measureOp('shell.list500', async () => { await invoke('shell', { command: 'ls /home/main/perfio/many', runtime: 'workspace' }); });
    await measureOp('shell.search500', async () => { await invoke('shell', { command: 'grep -r -l needle /home/main/perfio/many', runtime: 'workspace' }); });
    await measureOp('file.search500', async () => {
      for (let at = 0; at < 500; at++) await invoke('file', { op: 'search', path: `/home/main/perfio/many/f${String(at).padStart(3, '0')}.txt`, query: 'needle' });
    });
    let anchor = 'anchor-a';
    const readEdit = async () => { await invoke('file', { op: 'read', path: '/home/main/perfio/edit.txt' }); };

    await measureOp('file.edit', async () => {
      const path = '/home/main/perfio/edit.txt';
      const next = anchor === 'anchor-a' ? 'anchor-b' : 'anchor-a';
      await invoke('file', { op: 'edit', path, edits: [{ old_text: anchor, new_text: next }] });
      anchor = next;
    }, readEdit);
    await measureOp('shell.edit', async () => {
      const next = anchor === 'anchor-a' ? 'anchor-b' : 'anchor-a';
      await invoke('shell', { command: `sed -i 's/${anchor}/${next}/' /home/main/perfio/edit.txt`, runtime: 'workspace' });
      anchor = next;
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
