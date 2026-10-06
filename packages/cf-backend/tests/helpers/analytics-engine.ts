/**
 * Workers Analytics Engine as the platform runs it, for a flow that writes rows through the dataset bindings and reads
 * them back through the SQL API: each `writeDataPoint` becomes a row (`blob1..`, `double1..`, `index1`, `timestamp`,
 * `_sample_interval` 1), and the API runs the query text the control plane sends over those rows. It speaks the subset
 * of Analytics Engine SQL that `obs/analytics/query.ts` builds and refuses anything else by name, so a query the real
 * API would read differently cannot pass here unread.
 */
import * as v from 'valibot';

type Cell = string | number | null;

type Row = Record<string, Cell>;

const PointSchema = v.object({
  indexes: v.optional(v.array(v.nullable(v.string()))),
  blobs: v.optional(v.array(v.nullable(v.string()))),
  doubles: v.optional(v.array(v.number())),
});

function dataset(rows: Row[], now: () => number) {
  return {
    writeDataPoint(point?: AnalyticsEngineDataPoint): void {
      const { indexes = [], blobs = [], doubles = [] } = v.parse(PointSchema, point ?? {});

      rows.push(Object.fromEntries<Cell>([
        ['timestamp', now()], ['_sample_interval', 1], ['index1', indexes[0] ?? ''],
        ...blobs.map((blob, i): [string, Cell] => [`blob${String(i + 1)}`, blob ?? '']),
        ...doubles.map((double, i): [string, Cell] => [`double${String(i + 1)}`, double]),
      ]));
    },
  };
}

/** Splits on commas outside parentheses and quotes. */
function topLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === "'") quoted = !quoted;
    else if (!quoted && c === '(') depth++;
    else if (!quoted && c === ')') depth--;
    else if (!quoted && depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i).trim());
      start = i + separator.length;
    }
  }

  parts.push(text.slice(start).trim());

  return parts;
}

const HOURS = /^INTERVAL '(\d+)' HOUR$/u;

function number(cell: Cell | undefined): number {
  return v.is(v.number(), cell) ? cell : 0;
}

/** The value one select expression takes over a group's rows. */
function evaluate(expr: string, group: readonly Row[]): Cell {
  const column = /^(blob\d+|double\d+|index1|timestamp|_sample_interval)$/u.exec(expr);

  if (column !== null) return group[0]?.[expr] ?? (expr.startsWith('double') ? 0 : '');

  const sum = /^SUM\((_sample_interval)(?: \* (double\d+))?\)$/u.exec(expr);

  if (sum !== null) return group.reduce((total, row) => total + number(row._sample_interval) * (sum[2] === undefined ? 1 : number(row[sum[2]])), 0);

  const ratio = topLevel(expr, ' / ');

  if (ratio.length === 2) {
    const [over = 0, under = 0] = ratio.map((side) => number(evaluate(side, group)));

    return under === 0 ? null : over / under;
  }

  const quantile = /^quantileExactWeighted\(([0-9.]+)\)\((double\d+), _sample_interval\)$/u.exec(expr);

  if (quantile !== null) {
    const sorted = [...group].sort((a, b) => number(a[quantile[2] ?? '']) - number(b[quantile[2] ?? '']));
    const total = sorted.reduce((weight, row) => weight + number(row._sample_interval), 0);
    let seen = 0;

    for (const row of sorted) {
      seen += number(row._sample_interval);

      if (seen >= Number(quantile[1]) * total) return number(row[quantile[2] ?? '']);
    }

    return null;
  }

  const hour = /^toStartOfInterval\(timestamp, INTERVAL '(\d+)' HOUR\)$/u.exec(expr);

  if (hour !== null) {
    const span = Number(hour[1]) * 3_600_000;

    return Math.floor(number(group[0]?.timestamp) / span) * span;
  }

  throw new Error(`this Analytics Engine does not read the expression ${expr}`);
}

function matches(condition: string, row: Row, now: number): boolean {
  const since = /^timestamp > NOW\(\) - (INTERVAL '\d+' HOUR)$/u.exec(condition);

  if (since !== null) return number(row.timestamp) > now - Number(HOURS.exec(since[1] ?? '')?.[1]) * 3_600_000;

  const listed = /^(blob\d+) IN \((.+)\)$/u.exec(condition);

  if (listed !== null) return topLevel(listed[2] ?? '', ',').map((item) => item.replace(/^'|'$/gu, '')).includes(String(row[listed[1] ?? ''] ?? ''));

  const compared = /^(blob\d+|index1) (=|!=) '([^']*)'$/u.exec(condition);

  if (compared === null) throw new Error(`this Analytics Engine does not read the condition ${condition}`);
  const equal = (row[compared[1] ?? ''] ?? '') === compared[3];

  return compared[2] === '=' ? equal : !equal;
}

const QUERY = /^SELECT (?<select>.+?)\nFROM (?<from>\w+)\nWHERE (?<where>.+?)(?:\nGROUP BY (?<group>.+?))?(?:\nORDER BY (?<order>\w+) DESC)?(?:\nLIMIT (?<limit>\d+))?$/su;

function run(tables: Readonly<Record<string, readonly Row[]>>, sql: string, now: number): Row[] {
  const parsed = QUERY.exec(sql.trim())?.groups;

  if (parsed === undefined) throw new Error(`this Analytics Engine does not read the query ${sql}`);

  const table = tables[parsed.from ?? ''];

  if (table === undefined) throw new Error(`no dataset ${String(parsed.from)}`);

  const select = topLevel(parsed.select ?? '', ',').map((item) => {
    const [expr = item, alias = item] = item.split(/ AS /u);

    return { expr, alias };
  });

  const rows = table.filter((row) => topLevel(parsed.where ?? '', ' AND ').every((condition) => matches(condition, row, now)));

  const keyOf = (row: Row) => (parsed.group ?? '').split(', ').filter(Boolean)
    .map((key) => JSON.stringify(evaluate(select.find((item) => item.alias === key)?.expr ?? key, [row]))).join('|');

  const groups = new Map<string, Row[]>();

  for (const row of rows) groups.set(keyOf(row), [...groups.get(keyOf(row)) ?? [], row]);

  const answered = [...groups.values()].map((group) => Object.fromEntries(select.map(({ expr, alias }) => [alias, evaluate(expr, group)])));
  const order = parsed.order;

  if (order !== undefined) answered.sort((a, b) => number(b[order]) - number(a[order]));

  return parsed.limit === undefined ? answered : answered.slice(0, Number(parsed.limit));
}

/** The two dataset bindings and the SQL API over them; `refuseNext` answers the next query as an edge proxy would. */
export function analyticsEngine(now: () => number = Date.now) {
  const tables = { kinu_agent_metrics: new Array<Row>(), kinu_control_plane_ops: new Array<Row>() };
  let refusals: Response[] = [];

  const sqlApi = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);

    if (!/\/accounts\/[^/]+\/analytics_engine\/sql$/u.test(url)) throw new Error(`not the Analytics Engine SQL API: ${url}`);
    const refusal = refusals.shift();

    if (refusal !== undefined) return refusal;

    return Response.json({ data: run(tables, v.parse(v.string(), init?.body), now()), meta: [], rows: 0 });
  };

  return {
    tables,
    bindings: { AGENT_METRICS: dataset(tables.kinu_agent_metrics, now), CONTROL_PLANE_OPS: dataset(tables.kinu_control_plane_ops, now) },
    sqlApi,
    refuseNext(...answers: Response[]): void { refusals = answers; },
  };
}
