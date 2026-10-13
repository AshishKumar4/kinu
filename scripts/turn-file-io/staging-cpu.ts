/** Read-only billing CPU replay over retained operation clocks; never creates or changes a workspace. */
import { Telemetry, readToken, type TelemetryEvent } from '../prod-logs';
import data from './staging-sample.json';

interface Cpu { readonly at: number; readonly ms: number }

function remember(held: Map<string, Cpu>, events: readonly TelemetryEvent[]): void {
  for (const row of events) {
    if (row.$workers.cpuTimeMs === undefined || row.$metadata.requestId === undefined) continue;
    const prior = held.get(row.$metadata.requestId);

    if (prior === undefined || row.$workers.cpuTimeMs > prior.ms) held.set(row.$metadata.requestId, { at: row.timestamp, ms: row.$workers.cpuTimeMs });
  }
}

const token = await readToken();

const timeline = new Telemetry(token, { worker: 'kinu-staging', from: data.startedAt - 120_000, to: data.endedAt + 20_000 });

const markers = await timeline.events([{ key: 'fields.workspace', operation: 'eq', type: 'string', value: data.workspace }], 1000);

const ids = [...new Set(markers.events.flatMap((row) => row.$workers.durableObjectId === undefined ? [] : [row.$workers.durableObjectId]))];

const result = [];

for (const op of data.operations) {
  const rows = new Map<string, Cpu>();

  for (const id of ids) {
    const telemetry = new Telemetry(token, { worker: 'kinu-staging', from: op.from - 1000, to: op.to + 1000 });

    const fetched = await telemetry.events([
      { key: '$workers.durableObjectId', operation: 'eq', type: 'string', value: id },
      { key: '$workers.cpuTimeMs', operation: 'gt', type: 'number', value: -1 },
    ], 1000);

    if (fetched.sampling !== 1) throw new Error(`CPU replay is sampled at ${String(fetched.sampling)}, so it is not an exact count`);
    remember(rows, fetched.events);
  }

  const values = [...rows.values()];

  const counted = op.windows.flatMap(([from, to]) => {
    const matched = values.filter((row) => row.at >= op.from + (from ?? 0) && row.at <= op.from + (to ?? 0));

    return matched.length === 0 ? [] : [matched.reduce((sum, row) => sum + row.ms, 0)];
  }).sort((a, b) => a - b);

  const row = { label: op.label, matchedSamples: counted.length, samples: op.windows.length,
    cpuP50Ms: counted[Math.ceil(counted.length * 0.5) - 1] ?? null, cpuP95Ms: counted[Math.ceil(counted.length * 0.95) - 1] ?? null };

  result.push(row);
  process.stdout.write(JSON.stringify({ event: 'staging-cpu-operation', ...row }) + '\n');
}

process.stdout.write(JSON.stringify({ event: 'staging-cpu', sha: data.sha, workspace: data.workspace, ids, measured: result }) + '\n');
