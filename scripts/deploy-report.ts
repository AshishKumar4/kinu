/**
 * THE DEPLOY'S ONE FAILURE REPORT (L18). Every phase after a deploy's upload runs to its end whatever goes red, so one
 * deploy captures every failure, and this is where they land: every red row with its finding, grouped by phase, in one
 * file one fixer works from. The ladder records each red row (`recordRed`, the row's whole output in a log of its own),
 * each row it was told not to run and why (`recordSkipped`), and what a fixer should act on that is no red
 * (`recordNotice`); deploy.sh records its own steps that went red, the work it started and does not wait for, and
 * when it reached each mark; `render` writes `report.md` beside them and prints its path.
 *
 * DIFFERENTIAL. Each red is marked NEW or CARRIED OVER from the previous report of the same environment, and the report
 * lists the merges between the two deployed commits, so a fixer starts from what this deploy's merges broke.
 *
 *   bun scripts/deploy-report.ts open <environment> <mode> <sha>        a deploy's report directory; prints its path
 *   bun scripts/deploy-report.ts note <dir> <phase> <what> <finding>    a step of the deploy's own that went red
 *   bun scripts/deploy-report.ts dispatched <dir> <what> <url>          work the deploy started and does not wait for
 *   bun scripts/deploy-report.ts mark <dir> <mark> <seconds>            when the deploy reached <mark>
 *   bun scripts/deploy-report.ts render <dir>                           write report.md; print its path; exit 1 on a red
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

const root = new URL('..', import.meta.url).pathname;

/** Where every deploy's report lives, one directory per environment: gitignored and durable, never the swept temp
 *  directory. */
export const REPORTS = join(root, 'bench-artifacts', 'deploys');

/** How much of a red row's output the report quotes; the whole output is in the row's log. */
const TAIL_LINES = 40;

const MetaSchema = v.object({ environment: v.string(), mode: v.string(), sha: v.string(), startedAt: v.string() });

const EntrySchema = v.variant('kind', [
  v.object({
    kind: v.literal('red'), phase: v.string(), what: v.string(), command: v.string(), verdict: v.string(),
    finding: v.string(), reproduce: v.string(), log: v.string(), tail: v.array(v.string()),
  }),
  v.object({ kind: v.literal('step'), phase: v.string(), what: v.string(), finding: v.string() }),
  v.object({ kind: v.literal('notice'), phase: v.string(), what: v.string(), notice: v.string() }),
  v.object({ kind: v.literal('skipped'), phase: v.string(), what: v.string(), why: v.string() }),
  v.object({ kind: v.literal('dispatched'), what: v.string(), url: v.string() }),
  v.object({ kind: v.literal('mark'), mark: v.string(), seconds: v.number() }),
]);

export type ReportEntry = v.InferOutput<typeof EntrySchema>;

const SummarySchema = v.object({
  sha: v.string(),
  environment: v.string(),
  mode: v.string(),
  startedAt: v.string(),
  dir: v.string(),
  reds: v.array(v.string()),
  skipped: v.number(),
  totalSeconds: v.nullable(v.number()),
  liveSeconds: v.nullable(v.number()),
  testable: v.boolean(),
});

export type ReportSummary = v.InferOutput<typeof SummarySchema>;

/** One red's identity across deploys: its phase and what it runs, so a red of the same row is the same red. */
function identity(entry: ReportEntry): string | undefined {
  if (entry.kind === 'red') return `${entry.phase}: ${entry.command}`;

  if (entry.kind === 'step') return `${entry.phase}: ${entry.what}`;

  return undefined;
}

function entriesOf(dir: string): ReportEntry[] {
  const file = join(dir, 'entries.jsonl');

  if (!existsSync(file)) return [];

  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => v.parse(EntrySchema, JSON.parse(line)));
}

function append(dir: string, entry: ReportEntry): void {
  appendFileSync(join(dir, 'entries.jsonl'), `${JSON.stringify(entry)}\n`);
}

/** Opens a deploy's report directory, named for when it started and what it deploys. */
export function openReport(environment: string, mode: string, sha: string, now = new Date()): string {
  const dir = join(REPORTS, environment, `${now.toISOString().replace(/[:.]/gu, '-')}-${sha.slice(0, 12)}`);

  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ environment, mode, sha, startedAt: now.toISOString() })}\n`);

  return dir;
}

/** A red row of a ladder phase: its verdict, the command that reproduces it, its output's tail, and its whole output
 *  in a log of its own. */
export function recordRed(dir: string, red: {
  readonly phase: string; readonly what: string; readonly command: string; readonly verdict: string;
  readonly finding: string; readonly reproduce: string; readonly output: string;
}): void {
  const logs = join(dir, 'logs');

  mkdirSync(logs, { recursive: true });
  // Each plan row runs once per deploy, so its command names its log; the hash keeps two long commands that share a
  // prefix apart.
  const slug = red.command.replace(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80);
  const log = join(logs, `${slug}-${createHash('sha256').update(red.command).digest('hex').slice(0, 12)}.log`);

  writeFileSync(log, red.output);
  append(dir, {
    kind: 'red', phase: red.phase, what: red.what, command: red.command, verdict: red.verdict, finding: red.finding,
    reproduce: red.reproduce, log, tail: red.output.trimEnd().split('\n').slice(-TAIL_LINES),
  });
}

/** A step that went red outside any row: one of the deploy's own, or a phase whose runner reported no rows. */
export function recordStep(dir: string, step: { readonly phase: string; readonly what: string; readonly finding: string }): void {
  append(dir, { kind: 'step', phase: step.phase, what: step.what, finding: step.finding });
}

/** Something a fixer should act on that is not a red: the deploy's verdict does not read it. */
export function recordNotice(dir: string, notice: { readonly phase: string; readonly what: string; readonly notice: string }): void {
  append(dir, { kind: 'notice', phase: notice.phase, what: notice.what, notice: notice.notice });
}

/** A plan row the deploy did not run, and why. */
export function recordSkipped(dir: string, skipped: { readonly phase: string; readonly command: string; readonly why: string }): void {
  append(dir, { kind: 'skipped', phase: skipped.phase, what: skipped.command, why: skipped.why });
}

/** The report a deploy's differential compares with: the last in `index` (an environment's) before `dir`, and never a
 *  gates-only rehearsal's, which ran no tier. */
export function previousSummary(index: string, dir: string): ReportSummary | undefined {
  if (!existsSync(index)) return undefined;

  return readFileSync(index, 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => v.parse(SummarySchema, JSON.parse(line)))
    .filter((summary) => summary.dir !== dir && summary.mode !== 'gates-only')
    .at(-1);
}

/** The merges between two deployed commits, or why none can be listed. */
export type Merges = { readonly kind: 'listed'; readonly merges: readonly string[] } | { readonly kind: 'unlisted'; readonly why: string };

/** The merges from `from` to `to`, each `<short sha> <subject>`, or why there is no such range. */
function mergesBetween(from: string, to: string): Merges {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', from, to], { cwd: root, stdio: 'ignore' });
  } catch (error) {
    // git's own answer for "not an ancestor" is exit 1; anything else is no answer at all.
    if (error instanceof Error && 'status' in error && error.status === 1) {
      return { kind: 'unlisted', why: `${from.slice(0, 12)} is not an ancestor of ${to.slice(0, 12)}` };
    }

    throw error;
  }

  const log = execFileSync('git', ['log', '--merges', '--format=%h %s', `${from}..${to}`], { cwd: root, encoding: 'utf8' });

  return { kind: 'listed', merges: log.split('\n').filter((line) => line !== '') };
}

/** What one deploy's report is rendered from. */
export interface ReportInput {
  readonly dir: string;
  readonly meta: v.InferOutput<typeof MetaSchema>;
  readonly entries: readonly ReportEntry[];
  /** The previous report of the environment, and the merges since its commit. */
  readonly previous?: { readonly summary: ReportSummary; readonly merges: Merges };
}

/** The report's text, and the summary the next deploy's differential reads. */
export interface RenderedReport {
  readonly text: string;
  readonly summary: ReportSummary;
}

/** A titled section of the report, or nothing when it has no line. */
function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : ['', `## ${title}`, '', ...lines];
}

/** The title, when the deploy served the build and ended, and what it is compared with. */
function headerLines(input: ReportInput, marks: ReadonlyMap<string, number>, counts: { readonly reds: number; readonly fresh: number; readonly skipped: number }): string[] {
  const { meta, previous } = input;
  const served = marks.get('live');
  const ended = marks.get('end');

  const lines = [
    `# Deploy of ${meta.sha.slice(0, 12)} to ${meta.environment} (${meta.mode}): ${String(counts.reds)} red`
      + (previous === undefined ? '' : ` (${String(counts.fresh)} new, ${String(counts.reds - counts.fresh)} carried over)`)
      + `, ${String(counts.skipped)} skipped`,
    '',
    `Started ${meta.startedAt}. ${served === undefined ? `${meta.environment} never served this build` : `${meta.environment} served this build after ${String(served)} s`}`
      + `${ended === undefined ? '' : `; the deploy took ${String(ended)} s`}.`,
    '',
    previous === undefined
      ? `No previous ${meta.environment} report to compare with.`
      : `Compared with the previous ${meta.environment} deploy, of ${previous.summary.sha.slice(0, 12)} (${previous.summary.dir}).`,
  ];

  if (previous?.merges.kind === 'listed') {
    lines.push('', `Merges since then (${String(previous.merges.merges.length)}):`, ...previous.merges.merges.map((merge) => `- ${merge}`));
  } else if (previous?.merges.kind === 'unlisted') {
    lines.push('', `Merges since then: none listed, because ${previous.merges.why}.`);
  }

  return lines;
}

/** Every red, grouped by the phase it went red in, each marked new or carried over. */
function redSections(reds: readonly ReportEntry[], isNew: (entry: ReportEntry) => boolean): string[] {
  const lines: string[] = [];
  const mark = (entry: ReportEntry): string => (isNew(entry) ? 'NEW' : 'CARRIED OVER');

  for (const phase of new Set(reds.map((entry) => (entry.kind === 'red' || entry.kind === 'step' ? entry.phase : '')))) {
    lines.push('', `## ${phase}`);

    for (const entry of reds) {
      if (entry.kind === 'red' && entry.phase === phase) {
        lines.push('', `### ${mark(entry)}: ${entry.what} (${entry.verdict})`, '', entry.finding, '',
          `- command: \`${entry.command}\``, `- reproduce: \`${entry.reproduce}\``, `- whole output: ${entry.log}`, '',
          '```', ...entry.tail, '```');
      } else if (entry.kind === 'step' && entry.phase === phase) {
        lines.push('', `### ${mark(entry)}: ${entry.what}`, '', entry.finding);
      }
    }
  }

  return lines;
}

export function renderReport(input: ReportInput): RenderedReport {
  const { dir, meta, entries, previous } = input;
  const reds = entries.filter((entry) => identity(entry) !== undefined);
  const carried = new Set(previous?.summary.reds ?? []);
  const isNew = (entry: ReportEntry): boolean => !carried.has(identity(entry) ?? '');
  const marks = new Map(entries.flatMap((entry) => (entry.kind === 'mark' ? [[entry.mark, entry.seconds] as const] : [])));
  const skipped = entries.flatMap((entry) => (entry.kind === 'skipped' ? [`- ${entry.phase}: \`${entry.what}\`, because ${entry.why}`] : []));
  const notices = entries.flatMap((entry) => (entry.kind === 'notice' ? [`- ${entry.phase}: ${entry.what}: ${entry.notice}`] : []));
  const dispatched = entries.flatMap((entry) => (entry.kind === 'dispatched' ? [`- ${entry.what}: ${entry.url}`] : []));
  const timings = [...marks].map(([name, seconds]) => `| ${name} | ${String(seconds)} |`);

  const lines = [
    ...headerLines(input, marks, { reds: reds.length, fresh: reds.filter(isNew).length, skipped: skipped.length }),
    ...redSections(reds, isNew),
    ...section('Not run', skipped),
    ...section('Notices, not reds', notices),
    ...section('Started, not awaited', dispatched),
    ...section('When', timings.length === 0 ? [] : ['| mark | seconds from the start |', '| --- | --- |', ...timings]),
  ];

  return {
    text: `${lines.join('\n')}\n`,
    summary: {
      sha: meta.sha, environment: meta.environment, mode: meta.mode, startedAt: meta.startedAt, dir,
      reds: reds.flatMap((entry) => identity(entry) ?? []), skipped: skipped.length,
      totalSeconds: marks.get('end') ?? null, liveSeconds: marks.get('live') ?? null, testable: marks.has('live'),
    },
  };
}

if (import.meta.main) {
  const [command, first = '', ...rest] = process.argv.slice(2);

  if (command === 'open' && rest.length === 2) {
    console.log(openReport(first, rest[0] ?? '', rest[1] ?? ''));
    process.exit(0);
  }

  if (command === 'note' && rest.length === 3) {
    recordStep(first, { phase: rest[0] ?? '', what: rest[1] ?? '', finding: rest[2] ?? '' });
    process.exit(0);
  }

  if (command === 'dispatched' && rest.length === 2) {
    append(first, { kind: 'dispatched', what: rest[0] ?? '', url: rest[1] ?? '' });
    process.exit(0);
  }

  if (command === 'mark' && rest.length === 2) {
    append(first, { kind: 'mark', mark: rest[0] ?? '', seconds: Number(rest[1]) });
    process.exit(0);
  }

  if (command === 'render' && rest.length === 0) {
    const meta = v.parse(MetaSchema, JSON.parse(readFileSync(join(first, 'meta.json'), 'utf8')));
    const index = join(REPORTS, meta.environment, 'index.jsonl');
    const previous = previousSummary(index, first);

    const { text, summary } = renderReport({
      dir: first, meta, entries: entriesOf(first),
      previous: previous === undefined ? undefined : { summary: previous, merges: mergesBetween(previous.sha, meta.sha) },
    });

    writeFileSync(join(first, 'report.md'), text);
    writeFileSync(join(first, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    appendFileSync(index, `${JSON.stringify(summary)}\n`);
    console.log(`deploy report: ${join(first, 'report.md')} — ${String(summary.reds.length)} red, ${String(summary.skipped)} not run`);
    process.exit(summary.reds.length === 0 ? 0 : 1);
  }

  console.error('usage: bun scripts/deploy-report.ts open|note|dispatched|mark|render …');
  process.exit(2);
}
