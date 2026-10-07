import { WORKSPACE_ROOT } from '@kinu.run/core';
import { shows, type Sight } from '../src/sight';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import { answerShows, answersWithSlates, madeNoApp } from './ephemeral';
import { Seeded } from './seeded';

// A one-off visual answer over live data: a chart of an API's hourly p95 latency, read from a log that keeps
// growing. The answer should be an ephemeral slate whose page reads the file through `workspace` each time it is
// shown, not an app and not a copy of the numbers: once the checker appends an hour the agent never saw, a fresh
// page must chart it too. Each hour's values are planted so every common percentile rule gives the same p95 and the
// hour's maximum is not it.

const MISSION = "Atlas Payments' API on-call workspace.";

const LOG_PATH = `${WORKSPACE_ROOT}/logs/api.jsonl`;

const DAY = '2027-06-02';

/** Each hour's p95 in milliseconds, by hour of the day. */
const P95 = { '09': 182, '10': 205, '11': 231, '12': 318, '13': 296, '14': 247, '15': 219, '16': 263, '17': 191 } as const;

/** The hour the checker appends after the answer, which the agent never saw. */
const LATE_HOUR = { hour: '18', p95: 274 } as const;

const ROUTES = ['/v1/charges', '/v1/refunds', '/v1/customers', '/v1/payouts'];

/**
 * Forty requests in `hour`: thirty-six faster than `p95`, three at it (ranks 37 to 39) and one far slower (rank 40).
 * Nearest-rank, linear interpolation (inclusive or exclusive) and every rule between land on ranks 38 or 39, so all
 * give `p95`; the maximum is the slow one. Lines are in time order, as a server writes them.
 */
function hourOfRequests(hour: string, p95: number): string[] {
  const random = new Seeded(Number(`2027060${hour}`));
  const latencies = [...Array.from({ length: 36 }, () => random.int(40, p95 - 1)), p95, p95, p95, p95 * 3 + random.int(1, 50)];
  const seconds = latencies.map(() => random.int(0, 3_599)).sort((left, right) => left - right);

  return latencies.map((latency) => ({ latency, order: random.next() })).sort((left, right) => left.order - right.order).map(({ latency }, index) => {
    const second = seconds[index];
    const ts = `${DAY}T${hour}:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.${String(random.int(0, 999)).padStart(3, '0')}Z`;

    return JSON.stringify({ ts, route: random.pick(ROUTES), method: 'POST', status: 200, latency_ms: latency });
  });
}

const LOG = `${Object.entries(P95).flatMap(([hour, p95]) => hourOfRequests(hour, p95)).join('\n')}\n`;

const LATE_LINES = `${hourOfRequests(LATE_HOUR.hour, LATE_HOUR.p95).join('\n')}\n`;

/** A chart that shows each of `values`, as the text a person reads off it. */
function charts(values: readonly number[]): (sight: Sight) => boolean {
  return (sight) => values.every((value) => shows(sight.text, value));
}

const SEEDED: readonly number[] = Object.values(P95);

const task = defineEvalTask({
  id: 'latency-chart',
  mission: MISSION,
  turns: [{
    seed: [{ path: LOG_PATH, content: LOG }],
    prompt: `Chart the p95 latency of the requests in ${LOG_PATH} by hour, with each hour's p95 written on the
chart so I can read it. The log keeps growing through the day, so the chart should read the file each time
it's shown rather than keep a copy of today's numbers.`,
    verify: async (verifier) => {
      await answersWithSlates(verifier, 1);
      await madeNoApp(verifier);

      await verifier.check('the-chart-shows-each-hours-p95', () => answerShows(verifier, [], charts(SEEDED)));
      await verifier.check('a-reload-shows-the-same', () => answerShows(verifier, [], charts(SEEDED)));

      await verifier.check('the-chart-reads-the-file', async () => {
        await verifier.writeFile(LOG_PATH, `${LOG}${LATE_LINES}`);

        return answerShows(verifier, [], charts([...SEEDED, LATE_HOUR.p95]));
      });
    },
  }],
});

// Every hour's planted p95 is distinct, so one shown value cannot stand for two hours.
if (new Set([...SEEDED, LATE_HOUR.p95]).size !== SEEDED.length + 1) throw new Error('two hours share a planted p95');

defineTaskEval(task);
