import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask, type SeedFile } from '../src/task';
import { matchesReference, type EvalVerifier, type Script, type SlateClient } from '../src/verifier';
import { Seeded } from './seeded';

// API gateway request logs, dropped into the workspace one file per day the way a log shipper
// would. The agent builds an analyser that reads the files, a new day and a rule change arrive,
// then it is asked what the data says. Every answer is computed here from the same generated lines.

const MISSION = "The Tidewater Payments platform team's workspace. We keep the API gateway's request logs here and dig through them when something is slow.";

const LOG_DIR = '/home/user/logs';

// ── The logs ─────────────────────────────────────────────────────────

type Request = { at: string; method: string; path: string; status: number; durationMs: number; colo: string };

/** One log line, and the request it records; `null` for a line that records none. */
type Line = { text: string; request: Request | null };

type Profile = { method: string; path: (random: Seeded) => string; weight: number; baseMs: number };

const PROFILES: readonly Profile[] = [
  { method: 'GET', path: (random) => `/api/orders/${String(random.int(1000, 9999))}`, weight: 30, baseMs: 45 },
  { method: 'POST', path: () => '/api/orders', weight: 10, baseMs: 120 },
  { method: 'GET', path: (random) => `/api/users/${String(random.int(1, 500))}/cart`, weight: 15, baseMs: 60 },
  { method: 'GET', path: (random) => `/api/search?q=${random.pick(['shoes', 'lamp', 'desk', 'kettle', 'tent'])}`, weight: 20, baseMs: 150 },
  { method: 'POST', path: () => '/api/payments', weight: 8, baseMs: 240 },
  { method: 'GET', path: () => '/healthz', weight: 12, baseMs: 2 },
  { method: 'GET', path: () => '/static/app.js', weight: 5, baseMs: 9 },
];

const COLOS = ['FRA', 'LHR', 'SIN', 'SJC', 'GRU'];

// The planted findings: search has a slow tail on the 2nd, payments fail for an hour on the 3rd.
const SLOW_SEARCH_DAY = '2027-06-02';

const FAILING_PAYMENTS = { day: '2027-06-03', hour: 14 };

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function status(random: Seeded, request: { method: string; path: string }, day: string, hour: number): number {
  const { method, path } = request;

  if (method === 'POST' && path === '/api/payments' && day === FAILING_PAYMENTS.day && hour === FAILING_PAYMENTS.hour && random.next() < 0.3) return 502;

  if (path === '/healthz') return 200;

  if (random.next() < 0.012) return random.pick([500, 502, 503]);

  if (path.startsWith('/api/search') && random.next() < 0.03) return 429;

  if ((path.startsWith('/api/orders/') || path.startsWith('/api/users/')) && random.next() < 0.03) return 404;

  return method === 'POST' ? 201 : 200;
}

function malformed(random: Seeded, at: string): string {
  return random.pick([
    `# rotated by logrotate at ${at}`,
    `${at} GET /api/search?q=lamp 200`,
    '-- upstream connection reset by peer --',
    `${at} GET /api/orders/${String(random.int(1000, 9999))} 200 ?ms FRA`,
    `${at} GET /api/orders/${String(random.int(1000, 9999))} 200 41ms FRA retry=1`,
    `${at} POST /api/orders OK 118ms LHR`,
  ]);
}

function generateDay(day: string, seed: number, count: number): Line[] {
  const random = new Seeded(seed);
  const total = PROFILES.reduce((sum, profile) => sum + profile.weight, 0);
  const lines: { sortKey: number; line: Line }[] = [];

  for (let index = 0; index < count; index += 1) {
    const roll = random.next() * total;
    let reached = 0;
    const profile = PROFILES.find((candidate) => roll < (reached += candidate.weight));

    if (profile === undefined) throw new Error('the request profiles have no weight');
    const seconds = random.int(0, 86_399);
    const hour = Math.floor(seconds / 3600);
    const at = `${day}T${pad(hour)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}.${pad(random.int(0, 999), 3)}Z`;
    const path = profile.path(random);
    const code = status(random, { method: profile.method, path }, day, hour);
    const spread = 0.4 + random.next() ** 2 * 3;
    const slowTail = day === SLOW_SEARCH_DAY && path.startsWith('/api/search') && random.next() < 0.15;
    const durationMs = slowTail ? random.int(1800, 4200) : Math.round(profile.baseMs * spread * (code >= 500 ? 3 : 1));
    const colo = random.pick(COLOS);
    const request = { at, method: profile.method, path, status: code, durationMs, colo };
    lines.push({ sortKey: seconds, line: { text: `${at} ${profile.method} ${path} ${String(code)} ${String(durationMs)}ms ${colo}`, request } });
  }

  for (let index = 0; index < 12; index += 1) {
    const seconds = random.int(0, 86_399);
    const at = `${day}T${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}.000Z`;
    lines.push({ sortKey: seconds, line: { text: malformed(random, at), request: null } });
  }

  return lines.sort((left, right) => left.sortKey - right.sortKey).map(({ line }) => line);
}

type LogDay = { date: string; lines: Line[] };

function logDay(date: string, seed: number, count: number): LogDay {
  return { date, lines: generateDay(date, seed, count) };
}

const JUNE_1 = logDay('2027-06-01', 20270601, 1600);

const JUNE_2 = logDay('2027-06-02', 20270602, 1700);

const JUNE_3 = logDay('2027-06-03', 20270603, 1500);

const JUNE_4 = logDay('2027-06-04', 20270604, 1650);

/** Written by the checker in the middle of turn 2's checks, to see the slate read what it has not seen. */
const JUNE_5 = logDay('2027-06-05', 20270605, 400);

/** A file as the shipper writes it: two blank lines in the middle, a newline at the end. */
function fileOf(day: LogDay): SeedFile {
  const texts = day.lines.map((line) => line.text);
  texts.splice(Math.floor(texts.length / 3), 0, '');
  texts.splice(Math.floor((2 * texts.length) / 3), 0, '');

  return { path: `${LOG_DIR}/${day.date}.log`, content: `${texts.join('\n')}\n` };
}

// ── The contract ─────────────────────────────────────────────────────

const METHODS = ['routes', 'days', 'slowest'] as const;

type Method = (typeof METHODS)[number];

const RouteRow = v.object({ route: v.string(), requests: v.number(), errors: v.number(), p50Ms: v.number(), p95Ms: v.number() });

const ANSWERS: Record<Method, v.GenericSchema<JsonValue>> = {
  routes: v.object({ routes: v.array(RouteRow) }),
  days: v.object({ days: v.array(v.object({ date: v.string(), requests: v.number(), errors: v.number(), skipped: v.number() })) }),
  slowest: v.object({ routes: v.array(v.object({ route: v.string(), requests: v.number(), p95Ms: v.number() })) }),
};

function normalize(method: Method, answer: JsonValue): JsonValue {
  const parsed = v.safeParse(ANSWERS[method], answer);

  return parsed.success ? parsed.output : answer;
}

// ── The checker's own analysis ───────────────────────────────────────

type Rules = { health: boolean; isError: (code: number) => boolean };

const FIRST_RULES: Rules = { health: true, isError: (code) => code >= 500 && code <= 599 };

const TURN_2_RULES: Rules = { health: false, isError: (code) => (code >= 500 && code <= 599) || code === 429 };

function routeOf(request: Request): string {
  const path = request.path.split('?')[0] ?? request.path;

  return `${request.method} ${path.split('/').map((segment) => /^\d+$/.test(segment) ? ':id' : segment).join('/')}`;
}

function counted(day: LogDay, rules: Rules): Request[] {
  return day.lines.flatMap((line) => line.request === null || (!rules.health && line.request.path === '/healthz') ? [] : [line.request]);
}

/** Nearest rank: the value at position ceil(p/100 x n), counting from 1, of the ascending durations. */
function percentile(requests: readonly Request[], p: number): number {
  const sorted = requests.map((request) => request.durationMs).sort((left, right) => left - right);

  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function byRoute(requests: readonly Request[]): Map<string, Request[]> {
  const groups = new Map<string, Request[]>();

  for (const request of requests) {
    const route = routeOf(request);
    const group = groups.get(route);

    if (group === undefined) groups.set(route, [request]);
    else group.push(request);
  }

  return groups;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;

  return left < right ? -1 : 1;
}

/** The logs the slate can see at some point, and the rules in force then. */
type Logs = { days: readonly LogDay[]; rules: Rules };

function routesOn(logs: Logs, date: string): { route: string; requests: number; errors: number; p50Ms: number; p95Ms: number }[] {
  const day = logs.days.find((candidate) => candidate.date === date);

  return [...byRoute(day === undefined ? [] : counted(day, logs.rules))].map(([route, requests]) => ({
    route, requests: requests.length, errors: requests.filter((request) => logs.rules.isError(request.status)).length,
    p50Ms: percentile(requests, 50), p95Ms: percentile(requests, 95),
  })).sort((left, right) => right.requests - left.requests || compareText(left.route, right.route));
}

function slowestIn(logs: Logs, range: { from: string; to: string; n: number }): { route: string; requests: number; p95Ms: number }[] {
  const pooled = logs.days.filter((day) => day.date >= range.from && day.date <= range.to).flatMap((day) => counted(day, logs.rules));

  return [...byRoute(pooled)].map(([route, requests]) => ({ route, requests: requests.length, p95Ms: percentile(requests, 95) }))
    .sort((left, right) => right.p95Ms - left.p95Ms || compareText(left.route, right.route)).slice(0, range.n);
}

function referenceClient(logs: Logs): SlateClient<Method> {
  return (method, input) => {
    switch (method) {
      case 'routes': return Promise.resolve({ routes: routesOn(logs, v.parse(v.object({ date: v.string() }), input).date) });
      case 'slowest': return Promise.resolve({ routes: slowestIn(logs, v.parse(v.object({ from: v.string(), to: v.string(), n: v.number() }), input)) });
      case 'days': return Promise.resolve({
        days: logs.days.map((day) => {
          const requests = counted(day, logs.rules);

          return {
            date: day.date, requests: requests.length, errors: requests.filter((request) => logs.rules.isError(request.status)).length,
            skipped: day.lines.filter((line) => line.request === null).length,
          };
        }),
      });
    }
  };
}

// ── Checker helpers ──────────────────────────────────────────────────

async function sameAsReference(verifier: EvalVerifier, id: string, input: { logs: Logs; script: Script<Method> }): Promise<void> {
  await verifier.check(id, () => matchesReference({
    slate: verifier.slate('logs', METHODS), reference: referenceClient(input.logs), script: input.script, normalize,
  }));
}

const FIRST_DAYS = [JUNE_1, JUNE_2, JUNE_3];

const readEveryDay: Script<Method> = async (slate) => {
  for (const day of [...FIRST_DAYS, JUNE_4]) await slate('routes', { date: day.date });
};

/** The route with the highest p95 on the slow day, under turn 2's rules: what turn 3 asks for. */
const SLOWEST_ON_THE_SLOW_DAY = (() => {
  const [top, next] = slowestIn({ days: [JUNE_2], rules: TURN_2_RULES }, { from: JUNE_2.date, to: JUNE_2.date, n: 2 });

  if (top === undefined || next === undefined || top.p95Ms === next.p95Ms) throw new Error('the slow day no longer has one slowest route');

  return top.route;
})();

// ── The task ─────────────────────────────────────────────────────────

const task = defineEvalTask({
  id: 'request-logs',
  mission: MISSION,
  turns: [{
    seed: FIRST_DAYS.map(fileOf),
    prompt: `Our API gateway's request logs are in ${LOG_DIR}, one file per UTC day named YYYY-MM-DD.log, one
request per line:

    2027-06-01T00:00:03.214Z GET /api/orders/1042 200 38ms FRA

That is the time, method, path, status, duration and colo, separated by single spaces. A line is a
request only when it has exactly those six fields in that form; every other non-empty line is
skipped. Blank lines are neither requests nor skipped.

Build a slate with id "logs" that reads these files each time it is asked. More days will arrive, so
do not copy the logs into the slate. A route is the method and the path without its query string,
with every all-digit path segment replaced by :id, like "GET /api/orders/:id". An error is a 5xx
status. Percentiles are nearest-rank: sort the durations ascending and take the value at position
ceil(p/100 x n), counting from 1.

Its server methods take and return plain data, so I can check it:
- routes({ date }) -> { routes: Array<{ route, requests, errors, p50Ms, p95Ms }> }
  Every route with a request that day, most requests first, ties by route.
- days() -> { days: Array<{ date, requests, errors, skipped }> }
  One entry per log file, by date.
- slowest({ from, to, n }) -> { routes: Array<{ route, requests, p95Ms }> }
  Pooling every request from the day \`from\` through the day \`to\`, the n routes with the highest
  p95, ties by route.`,
    verify: async (verifier) => {
      const logs: Logs = { days: FIRST_DAYS, rules: FIRST_RULES };

      await sameAsReference(verifier, 'routes-per-day-match-the-logs', {
        logs, script: async (slate) => {
          for (const day of FIRST_DAYS) await slate('routes', { date: day.date });
        },
      });

      await sameAsReference(verifier, 'days-count-requests-errors-and-skipped-lines', { logs, script: async (slate) => { await slate('days'); } });

      await sameAsReference(verifier, 'slowest-pools-the-range', {
        logs, script: async (slate) => {
          await slate('slowest', { from: '2027-06-01', to: '2027-06-02', n: 3 });
          await slate('slowest', { from: '2027-06-01', to: '2027-06-03', n: 5 });
          await slate('slowest', { from: '2027-06-03', to: '2027-06-03', n: 1 });
        },
      });
    },
  }, {
    seed: [fileOf(JUNE_4)],
    prompt: `The log for 2027-06-04 just landed. Two rule changes: health checks (requests to /healthz) no longer
count anywhere, not as requests and not as skipped lines, and a 429 now counts as an error like a
5xx does. They apply to every day, old and new.`,
    verify: async (verifier) => {
      await sameAsReference(verifier, 'new-rules-apply-to-every-day', { logs: { days: [...FIRST_DAYS, JUNE_4], rules: TURN_2_RULES }, script: readEveryDay });

      await verifier.check('a-new-file-is-read-when-asked', async () => {
        await verifier.writeFile(fileOf(JUNE_5).path, fileOf(JUNE_5).content);

        return matchesReference({
          slate: verifier.slate('logs', METHODS), reference: referenceClient({ days: [...FIRST_DAYS, JUNE_4, JUNE_5], rules: TURN_2_RULES }),
          normalize,
          script: async (slate) => {
            await slate('days');
            await slate('routes', { date: JUNE_5.date });
            await slate('slowest', { from: '2027-06-01', to: '2027-06-05', n: 4 });
          },
        });
      });
    },
  }, {
    prompt: `Which route had the highest p95 latency on ${SLOW_SEARCH_DAY}? Reply with just the route, like GET /api/orders/:id.`,
    verify: async (verifier) => {
      await verifier.check('names-the-slowest-route-from-the-logs', async () => {
        const reply = verifier.replies.at(-1)?.trim() ?? '';
        const answer = reply.replace(/^[`"'*]+|[`"'*.]+$/g, '').trim();

        return { pass: answer === SLOWEST_ON_THE_SLOW_DAY, evidence: { reply, expected: SLOWEST_ON_THE_SLOW_DAY } };
      });

      await sameAsReference(verifier, 'asking-changes-nothing', {
        logs: { days: [...FIRST_DAYS, JUNE_4, JUNE_5], rules: TURN_2_RULES },
        script: async (slate) => { await slate('routes', { date: SLOW_SEARCH_DAY }); },
      });
    },
  }],
});

defineTaskEval(task);
