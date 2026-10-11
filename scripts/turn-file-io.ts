/** Exact-built-bundle workerd measurements. Run only on armada; model inference is a zero-delay script outside workerd. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { createServer } from 'node:net';
import { build } from 'esbuild';
import { nodeRequireAsImport } from '../packages/cf-backend/esbuild-node-require';
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

const COMMAND_HOSTS: readonly string[] = ['github.com', 'codeload.github.com', 'registry.npmjs.org'];

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

/** What a measured run records as a streamed model step opens: its timing, a heap sample, or a counts cut. */
async function measureStep(step: number, entered: number, consumed: number): Promise<void> {
  const label = step === 0 ? 'open' : `step-${String(step)}`;

  if (mode === 'time') stepTimings.push({ label, wallMs: entered - phaseWall - phaseExcluded, cpuMs: consumed - phaseCpu });

  if (mode === 'heap') await sampleHeap();

  if (mode === 'counts') phases.push(v.parse(CutSchema, JSON.parse(await ask(`/cut?label=${label}&resume=1`))));
}

async function model(request: Request): Promise<Response> {
  const entered = performance.now();
  const consumed = measuring ? cpu(enginePid) : 0;
  const url = new URL(request.url);

  // Only the commands subject reaches the network: its clone and install are what it measures.
  if (subject === 'commands' && COMMAND_HOSTS.includes(url.hostname)) return await passedThrough(request);

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

  if (subject === 'pipes') {
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
