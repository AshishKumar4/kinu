/**
 * THE COMPLEXITY GATE: storage and hot-path cost, counted, never timed.
 *
 * A clock flakes under load; a row count does not. Each subject drives production code through a
 * scripted workload at two or three sizes inside workerd, on a Durable Object's own SQLite, and
 * `complexity-probe.ts` counts what one operation at each size cost: the rows each table's
 * statements read and wrote (the SQL cursors' own `rowsRead` and `rowsWritten`) and read beyond the
 * rows they returned (a scan's surplus), each table's stored rows and payload bytes, and the model
 * request's bytes where the operation prepares one.
 * Each subject declares how each count may grow with its size, and a count that grows one class
 * faster than declared fails, naming the table, the counter and both measurements. The O(n²)
 * render copies the session store once made per turn are the defect this exists to keep out.
 */
import { env } from 'cloudflare:workers';
import { afterAll, expect, test } from 'vitest';
import type { ComplexityProbeDO, OperationCost } from './complexity-probe';
import { judge, steepest, type GrowthClass, type GrowthCounter, type GrowthFinding } from './growth';

type Probe = DurableObjectStub<ComplexityProbeDO>;

type Counted = 'rowsRead' | 'rowsWritten' | 'statements' | 'rowsScanned';

interface Subject {
  readonly name: string;
  /** What the size counts. */
  readonly unit: string;
  readonly sizes: readonly number[];
  readonly run: (probe: Probe, size: number) => Promise<OperationCost>;
  /** The class every table's counts may not outgrow, unless `tables` names that table and count: an
   *  exception is the one read or write the operation cannot avoid, and says so in `why`. A table's
   *  stored rows and payload bytes grow as its writes may. */
  readonly rows: Readonly<Record<Counted, GrowthClass>>;
  readonly tables?: Readonly<Record<string, Partial<Readonly<Record<Counted, GrowthClass>>>>>;
  readonly requestBytes?: GrowthClass;
  /** Why the declared classes are the right ones. */
  readonly why: string;
}

const SUBJECTS: readonly Subject[] = [{
  name: 'session store, one turn',
  unit: 'turns of history',
  sizes: [50, 300],
  run: async (probe, size) => await probe.sessionTurn(size),
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  requestBytes: 'O(n)',
  why: 'a turn writes what it adds (its input, one call and result, its answer, its claim and its two '
    + 'requests) in a fixed number of statements, whatever came before it, and reads none of the memberships '
    + 'before it: a context keeps the head it last read or wrote. Only the request bytes grow with the '
    + 'history, since each request carries it',
}, {
  name: 'workspace Diffs, one read',
  unit: 'files in the workspace',
  sizes: [10, 1_000, 10_000],
  run: async (probe, size) => await probe.diffRead(size),
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  tables: { vfs_baseline_manifest: { rowsRead: 'O(n)' } },
  why: 'a read compares the tree with the baseline manifest, which it reads whole; it reads the bytes of '
    + 'only the files whose size or mtime moved (file_chunks, vfs_baseline_blob) and writes nothing',
}, {
  name: 'slate, eight new versions in a row',
  unit: 'versions already taken',
  // Both well past Nimbus's content maintenance page (50 content ids a write): below it the page
  // fills with the store, above it the scan is the same bounded page at every size.
  sizes: [256, 1_536],
  run: async (probe, size) => await probe.slateVersion(size),
  rows: { rowsRead: 'O(1)', rowsWritten: 'O(1)', statements: 'O(1)', rowsScanned: 'O(1)' },
  why: 'a version walks the slate\'s own files and stores the changed blob and one manifest; the versions '
    + 'before it are content-addressed blobs it never reads',
}, {
  name: 'slate, one fork',
  unit: 'files in the slate',
  sizes: [10, 100, 1_000],
  run: async (probe, size) => await probe.slateFork(size),
  rows: { rowsRead: 'O(n)', rowsWritten: 'O(n)', statements: 'O(n)', rowsScanned: 'O(n)' },
  why: 'a fork writes every file of the version into the new slate once',
}];

/** Every count the subject's declarations govern, one value per size. */
function countersOf(subject: Subject, measured: readonly OperationCost[]): GrowthCounter[] {
  const tables = new Set(measured.flatMap((cost) => Object.keys(cost.tables)));
  const counters: GrowthCounter[] = [];

  for (const table of [...tables].sort()) {
    for (const counted of ['rowsRead', 'rowsWritten', 'statements', 'rowsScanned'] as const) {
      counters.push({
        name: `${table}.${counted}`,
        declared: subject.tables?.[table]?.[counted] ?? subject.rows[counted],
        values: measured.map((cost) => cost.tables[table]?.[counted] ?? 0),
      });
    }
  }

  const stored = new Set(measured.flatMap((cost) => [...Object.keys(cost.storedRows), ...Object.keys(cost.storedBytes)]));

  for (const table of [...stored].sort()) {
    const declared = subject.tables?.[table]?.rowsWritten ?? subject.rows.rowsWritten;

    counters.push({ name: `${table}.storedRows`, declared, values: measured.map((cost) => Math.max(0, cost.storedRows[table] ?? 0)) });
    counters.push({ name: `${table}.storedBytes`, declared, values: measured.map((cost) => Math.max(0, cost.storedBytes[table] ?? 0)) });
  }

  if (subject.requestBytes !== undefined) {
    counters.push({ name: 'request.bytes', declared: subject.requestBytes, values: measured.map((cost) => cost.requestBytes ?? 0) });
  }

  return counters;
}

function describeFinding(subject: Subject, finding: GrowthFinding): string {
  return `${subject.name}: ${finding.counter} grew as n^${finding.exponent.toFixed(2)} from ${String(finding.from.size)} to `
    + `${String(finding.to.size)} ${subject.unit} (${String(finding.from.value)} -> ${String(finding.to.value)}); declared ${finding.declared}`;
}

/** Each subject's figures, printed after the file with what the gate is blind to. Under a coding agent vitest
 *  picks its agent reporter, which shows a file's console only when the file fails; `--reporter=default` shows it always. */
const reports: string[] = [];

afterAll(() => {
  console.log([
    ...reports,
    'complexity: blind to',
    '  CPU, memory and wall time: a path that re-parses or copies in memory while its SQL stays flat is invisible;',
    '  storage outside this object\'s SQLite (KV, R2, D1, another object\'s database, the model provider);',
    '  growth past the largest size measured, and growth hidden inside the exponent slack of a class;',
    '  which of the tables a statement names its rows came from: it is charged to all of them jointly, and a',
    '    trigger\'s rows to the statement that fired it;',
    '  bytes rewritten in place: a row replaced by one of the same size is one row written and no stored growth;',
    '  the database\'s page count, printed but not judged: it moves 4 KiB at a time;',
    '  a step that prunes: the session subject\'s messages are too small to prune, so the render rows a pruned copy',
    '    stores are not driven (the digest-named rows reverted on their own stay green);',
    '  operations no subject drives: the list above is the whole of what is judged.',
  ].join('\n'));
});

for (const subject of SUBJECTS) {
  test(`${subject.name} grows no faster than declared`, async () => {
    const measured: OperationCost[] = [];

    // One fresh object per size, so each measurement starts from an empty database.
    for (const size of subject.sizes) {
      const probe = env.COMPLEXITY_PROBE.get(env.COMPLEXITY_PROBE.idFromName(`${subject.name}/${String(size)}/${crypto.randomUUID()}`));

      measured.push(await subject.run(probe, size));
    }

    const counters = countersOf(subject, measured);
    const report = [`complexity: ${subject.name}, by ${subject.unit} (${subject.sizes.join(', ')}); the exponent is the steepest between consecutive sizes`];

    for (const counter of counters) {
      const { exponent } = steepest(subject.sizes, counter.values);

      report.push(`  ${counter.name.padEnd(60)} ${counter.values.map((value) => String(value).padStart(10)).join('')}   n^${exponent.toFixed(2)}  declared ${counter.declared}`);
    }

    report.push(`  ${'database pages, in bytes (not judged)'.padEnd(60)} ${measured.map((cost) => String(cost.dbBytes).padStart(10)).join('')}`);
    reports.push(report.join('\n'));

    expect(judge(subject.sizes, counters).map((finding) => describeFinding(subject, finding)), subject.why).toEqual([]);
  });
}

