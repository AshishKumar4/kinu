/**
 * DBX-7's census of Durable Object to container traffic on the deployed Worker, read from Workers
 * Observability rather than inferred from code.
 *
 *   execs     the SDK's `sandbox.exec` events per Durable Object invocation, split by what woke it
 *             (alarm: heartbeat, checkpoint and startup rows; jsrpc: requests), and the commands'
 *             first words. Process-lane commands (`startProcess`) have no event and are not counted.
 *   container the `containers` dataset for the Worker's container application: that the container's
 *             stdout and stderr reach Workers Logs, and a sample of what arrives.
 *
 * The token is an API token with "Workers Observability > Read" (`CLOUDFLARE_API_TOKEN` or
 * `KINU_OBS_TOKEN`); the wrangler OAuth token is refused (`scripts/prod-logs.ts`).
 *
 *   bun scripts/bench-devbox-exec-census.ts [--worker kinu] [--since 6h] [--until <ISO>] [--app <name>]
 */
import * as v from 'valibot';

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

const QUERY_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`;

/** The API's page ceiling for one events query; a window holding more is reported as truncated. */
const EVENTS_LIMIT = 2_000;

const EventSchema = v.looseObject({
  timestamp: v.number(),
  source: v.optional(v.looseObject({ command: v.optional(v.string()), message: v.optional(v.string()) })),
  $metadata: v.looseObject({ origin: v.optional(v.string()), requestId: v.optional(v.string()), message: v.optional(v.string()) }),
  $workers: v.optional(v.looseObject({ durableObjectId: v.optional(v.string()) })),
  $containers: v.optional(v.looseObject({ applicationId: v.optional(v.string()) })),
});

type TelemetryEvent = v.InferOutput<typeof EventSchema>;

const ReplySchema = v.looseObject({
  success: v.boolean(),
  errors: v.optional(v.array(v.unknown())),
  result: v.optional(v.looseObject({ events: v.optional(v.looseObject({ events: v.optional(v.array(EventSchema)) })) })),
});

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? undefined : process.argv[index + 1];
}

function durationMs(text: string): number {
  const match = /^(\d+)([mh])$/.exec(text);

  if (match === null) throw new Error(`--since takes 30m / 6h shapes, got ${text}`);

  return Number(match[1]) * (match[2] === 'h' ? 3_600_000 : 60_000);
}

async function events(token: string, window: { from: number; to: number }, filters: readonly object[], dataset: string): Promise<TelemetryEvent[]> {
  const reply = await fetch(QUERY_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      queryId: 'kinu-devbox-exec-census', timeframe: window, view: 'events', limit: EVENTS_LIMIT,
      parameters: { datasets: [dataset], filters },
    }),
  });

  const body = v.parse(ReplySchema, await reply.json());

  if (!reply.ok || !body.success) throw new Error(`telemetry query answered ${String(reply.status)}: ${JSON.stringify(body.errors ?? []).slice(0, 300)}`);

  return body.result?.events?.events ?? [];
}

function execCensus(execs: readonly TelemetryEvent[]) {
  const invocations = new Map<string, { origin: string; commands: string[] }>();

  for (const event of execs) {
    const origin = event.$metadata.origin ?? 'unknown';
    const key = `${origin}:${event.$metadata.requestId ?? String(event.timestamp)}`;
    const row = invocations.get(key) ?? { origin, commands: [] };
    row.commands.push(event.source?.command ?? '');
    invocations.set(key, row);
  }

  const perInvocation: Record<string, Record<string, number>> = {};
  const firstWords: Record<string, number> = {};

  for (const { origin, commands } of invocations.values()) {
    const sizes = perInvocation[origin] ?? {};
    sizes[String(commands.length)] = (sizes[String(commands.length)] ?? 0) + 1;
    perInvocation[origin] = sizes;

    for (const command of commands) {
      const word = command.trim().split(/\s+/)[0] ?? '';
      firstWords[word] = (firstWords[word] ?? 0) + 1;
    }
  }

  return {
    execs: execs.length,
    truncated: execs.length === EVENTS_LIMIT,
    invocations: invocations.size,
    boxes: new Set(execs.map((event) => event.$workers?.durableObjectId)).size,
    perInvocation,
    firstWords,
  };
}

async function run(): Promise<void> {
  const token = process.env.KINU_OBS_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;

  if (token === undefined || token === '') throw new Error('set CLOUDFLARE_API_TOKEN or KINU_OBS_TOKEN to an API token with Workers Observability read');
  const worker = option('worker') ?? 'kinu';
  const to = option('until') === undefined ? Date.now() : Date.parse(option('until') ?? '');
  const window = { from: to - durationMs(option('since') ?? '6h'), to };
  const app = option('app') ?? `${worker}-kinusandbox`;

  const execs = await events(token, window, [
    { key: '$metadata.service', operation: 'eq', value: worker, type: 'string' },
    { key: '$metadata.message', operation: 'includes', value: 'sandbox.exec', type: 'string' },
  ], 'cloudflare-workers');

  const applications = await applicationIds(app);

  // The dataset's filter key is `$container.*`; the events it returns carry `$containers.*`.
  const ours = (await Promise.all(applications.map(async (id) => await events(token, window, [
    { key: '$container.applicationId', operation: 'eq', value: id, type: 'string' },
  ], 'containers')))).flat();

  process.stdout.write(`${JSON.stringify({
    worker, window: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
    exec: execCensus(execs),
    container: {
      application: app, applicationIds: applications, events: ours.length, truncated: ours.length === EVENTS_LIMIT * applications.length,
      sample: ours.slice(0, 5).map((event) => ({ at: new Date(event.timestamp).toISOString(), message: event.source?.message ?? event.$metadata.message })),
    },
  }, null, 2)}\n`);
}

/** Container application ids by name, from `wrangler containers list`: the dataset files logs under
 *  the application id, and a redeploy under the same name keeps it. */
async function applicationIds(name: string): Promise<string[]> {
  const listed = Bun.spawnSync(['bunx', 'wrangler', 'containers', 'list', '--json'], {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, stderr: 'pipe',
  });

  const text = listed.stdout.toString();
  const rows = v.parse(v.array(v.looseObject({ id: v.string(), name: v.string() })), JSON.parse(text.slice(text.indexOf('['))));

  return rows.filter((row) => row.name === name).map((row) => row.id);
}

if (import.meta.main) await run();
