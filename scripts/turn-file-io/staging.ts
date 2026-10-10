/** One eval-owned staging sample. Public file/terminal routes are intentionally a different boundary from native tools. */
import * as v from 'valibot';
import { resolvePublicSessionPlan, webHeaders } from '../../evals/src/session';
import { SCRIPTED_MODEL_SPEC } from '../../packages/test-utils/src/scripted-model-spec';
import { Telemetry, readToken } from '../prod-logs';
import { PERF_IO_MARKER } from '../turn-file-io-model';

const native = process.argv.includes('--native');

const samples = Number(process.argv.find((arg) => arg.startsWith('--samples='))?.slice(10) ?? '30');

const origin = 'https://staging.kinu.run';

const HealthSchema = v.object({ build: v.object({ sha: v.string() }) });

const health = v.parse(HealthSchema, await (await fetch(origin + '/api/health')).json());

if (!native && health.build.sha !== '26244c765') throw new Error(`expected staging 26244c765; observed ${health.build.sha}`);

const resolved = resolvePublicSessionPlan('perf-turn-file-io', SCRIPTED_MODEL_SPEC);

if (resolved.kind !== 'ready') throw new Error(resolved.remedy);

const session = await resolved.plan.open({ subject: 'perf-turn-file-io', purpose: 'Measure platform turn and file I/O in this disposable workspace.', genesis: false });

interface OperationSample { readonly label: string; readonly startedAt: number; readonly endedAt: number; readonly wallMs: number }

const measured: OperationSample[] = [];

const allStarted = Date.now();

const headers = webHeaders(resolved.plan.identity);

const fileUrl = (executor: string, path: string) => `${origin}/api/workspaces/${session.workspace}/files?executor=${executor}&path=${encodeURIComponent(path)}`;

const input = (bytes: number) => ('probe needle ' + 'x'.repeat(114) + '\n').repeat(Math.ceil(bytes / 128)).slice(0, bytes);

async function read(executor: string, path: string, bytes: number): Promise<void> {
  const response = await fetch(fileUrl(executor, path), { headers });

  if (!response.ok) throw new Error(`file GET ${executor} ${path}: ${String(response.status)} ${await response.text()}`);
  const body = await response.bytes();

  if (body.byteLength !== bytes) throw new Error(`read ${String(body.byteLength)} bytes, expected ${String(bytes)}`);
}

async function write(executor: string, path: string, content: string): Promise<void> {
  const response = await fetch(fileUrl(executor, path), { method: 'PUT', headers, body: content });
  const body = await response.text();

  if (!response.ok) throw new Error(`file PUT ${executor} ${path}: ${String(response.status)} ${body}`);
}

async function record(label: string, operation: (index: number) => Promise<void>): Promise<void> {
  await operation(-1);

  for (let index = 0; index < samples; index++) {
    const startedAt = Date.now();
    const started = performance.now();
    await operation(index);
    measured.push({ label, startedAt, endedAt: Date.now(), wallMs: performance.now() - started });
  }
}

try {
  await session.setLearning(false);
  const startedAt = Date.now();
  const started = performance.now();
  const short = await session.prompt('Say anything at all.');

  if (short.landed !== 'turn' || short.hadError) throw new Error('short turn did not complete');
  measured.push({ label: 'short-chat', startedAt, endedAt: Date.now(), wallMs: performance.now() - started });

  for (const executor of ['workspace', 'sandbox']) {
    const root = executor === 'workspace' ? '/home/main/perfio' : '/home/perfio';
    const setup = await session.execute(executor, `mkdir -p ${root}/many`);

    if ('error' in setup) throw new Error(`executor ${executor} did not start: ${setup.error}`);

    for (const bytes of [4096, 65536, 1048576]) {
      const path = `${root}/read-${String(bytes)}.txt`;
      await write(executor, path, input(bytes));
      await record(`${executor}.public.read.${String(bytes)}`, async () => { await read(executor, path, bytes); });
      await record(`${executor}.public.write.${String(bytes)}`, async (index) => { await write(executor, `${root}/write-${String(bytes)}-${String(index)}.txt`, input(bytes)); });
      await record(`${executor}.terminal.read.${String(bytes)}`, async () => { await session.execute(executor, `cat ${path}`); });
      await record(`${executor}.terminal.write.${String(bytes)}`, async (index) => { await session.execute(executor, `head -c ${String(bytes)} /dev/zero > ${root}/shell-${String(bytes)}-${String(index)}.bin`); });
    }

    if (executor !== 'workspace') continue;
    await session.execute(executor, `for i in $(seq 0 499); do echo needle > ${root}/many/f$i.txt; done`);
    await record('workspace.terminal.stat', async () => { await session.execute(executor, `stat ${root}/read-4096.txt`); });
    await record('workspace.terminal.list500', async () => { await session.execute(executor, `ls ${root}/many`); });
    await record('workspace.terminal.search500', async () => { await session.execute(executor, `grep -r -l needle ${root}/many`); });
    let marker = 'probe';
    await record('workspace.terminal.edit', async () => {
      const next = marker === 'probe' ? 'PROBE' : 'probe';
      await session.execute(executor, `sed -i 's/${marker}/${next}/' ${root}/read-4096.txt`);
      marker = next;
    });

    if (native) {
      await session.prompt(PERF_IO_MARKER + JSON.stringify({ id: 'native-file-check', work: [{ name: 'file', arguments: { op: 'read', path: `${root}/read-4096.txt` } }] }));
    }
  }

  const ended = Date.now();
  // Logs arrive asynchronously; this is an ingestion wait, outside every operation's timing.
  await Bun.sleep(10_000);
  const telemetry = new Telemetry(await readToken(), { worker: 'kinu-staging', from: allStarted - 1000, to: ended + 10_000 });
  const markers = await telemetry.events([{ key: 'fields.workspace', operation: 'eq', type: 'string', value: session.workspace }], 1000);
  const ids = [...new Set(markers.events.flatMap((row) => row.$workers.durableObjectId === undefined ? [] : [row.$workers.durableObjectId]))];
  const cpu: { readonly at: number; readonly ms: number }[] = [];

  for (const id of ids) {
    const events = await telemetry.events([{ key: '$workers.durableObjectId', operation: 'eq', type: 'string', value: id }], 20_000);
    const requests = new Map<string, { at: number; ms: number }>();

    for (const row of events.events) {
      if (row.$workers.cpuTimeMs === undefined || row.$metadata.requestId === undefined) continue;
      const prior = requests.get(row.$metadata.requestId);

      if (prior === undefined || row.$workers.cpuTimeMs > prior.ms) requests.set(row.$metadata.requestId, { at: row.timestamp, ms: row.$workers.cpuTimeMs });
    }

    cpu.push(...requests.values());
  }

  const quantile = (values: readonly number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? null;
  const labels = [...new Set(measured.map((sample) => sample.label))];

  const result = labels.map((label) => {
    const rows = measured.filter((sample) => sample.label === label);

    const cpuSamples = rows.flatMap((sample) => {
      const events = cpu.filter((event) => event.at >= sample.startedAt && event.at <= sample.endedAt);

      return events.length === 0 ? [] : [events.reduce((sum, event) => sum + event.ms, 0)];
    });

    return { label, samples: rows.length, wallP50Ms: quantile(rows.map((sample) => sample.wallMs), 0.5), wallP95Ms: quantile(rows.map((sample) => sample.wallMs), 0.95), rootCpuMatchedSamples: cpuSamples.length, rootDoCpuP50Ms: telemetry.sampling === 1 ? quantile(cpuSamples, 0.5) : null, rootDoCpuP95Ms: telemetry.sampling === 1 ? quantile(cpuSamples, 0.95) : null };
  });

  process.stdout.write(JSON.stringify({ event: 'staging-measurement', sha: health.build.sha, workspace: session.workspace, boundary: 'public raw-file HTTP and public terminal RPC; not native file/shell tools', startedAt: allStarted, endedAt: ended, cpuSampling: telemetry.sampling, rootDoIds: ids, rootCpuEvents: cpu.length, measured: result }) + '\n');
} finally {
  await session.teardown();
}
