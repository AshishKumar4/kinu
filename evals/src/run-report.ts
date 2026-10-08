/**
 * The run's deterministic account, per task and for the whole run, each value beside its change against production:
 * passes, wall time, steps, tokens, cost, the steady prompt cache and its fifth percentile, failed tool calls by tool
 * and cause, plan use, and the platform bugs Workers Logs saw in the run's workspaces. Computed from the trials' own
 * records and the logs alone; the reviewer's judgement is beside it, never in it.
 */
import type { EvalComparison, EvalStats } from './comparison';
import { rate, seconds, signed, tokens, usd } from './format';
import type { ToolFailure } from './results';
import type { TaskPlatform } from './platform';

type Row = { readonly name: string; readonly baseline: EvalStats | null; readonly candidate: EvalStats | null };

/** A measure as a cell: the candidate's value, and its change from the baseline's when both are known. */
type Column = {
  readonly title: string;
  readonly value: (side: EvalStats) => number | null;
  readonly show: (value: number) => string;
  readonly change: (delta: number) => string;
};

const share = (value: number) => rate(value);

const points = (delta: number) => signed(delta * 100, 1, ' pp');

const COLUMNS: readonly Column[] = [
  { title: 'Pass', value: (side) => side.trials === 0 ? null : side.passed / side.trials, show: share, change: (delta) => signed(delta * 100, 0, ' pp') },
  { title: 'Mean wall', value: (side) => side.meanWallTimeMs, show: seconds, change: (delta) => signed(delta / 1000, 1, ' s') },
  { title: 'Slowest', value: (side) => side.slowestTrialMs, show: seconds, change: (delta) => signed(delta / 1000, 1, ' s') },
  { title: 'Steps', value: (side) => side.meanModelTurns, show: (value) => value.toFixed(1), change: (delta) => signed(delta, 1) },
  { title: 'Input tokens', value: (side) => side.meanInputTokens, show: tokens, change: (delta) => `${delta < 0 ? '\u2212' : '+'}${tokens(Math.abs(delta))}` },
  { title: 'Output tokens', value: (side) => side.meanOutputTokens, show: tokens, change: (delta) => `${delta < 0 ? '\u2212' : '+'}${tokens(Math.abs(delta))}` },
  { title: 'Cost', value: (side) => side.meanCostUsd, show: usd, change: (delta) => `${delta < 0 ? '\u2212' : '+'}${usd(Math.abs(delta))}` },
  { title: 'Steady cache', value: (side) => side.steadyCacheHitRate, show: share, change: points },
  { title: 'Cache p5', value: (side) => side.steadyCacheP5, show: share, change: points },
  { title: 'Failed calls', value: (side) => side.trials === 0 ? null : failed(side.toolFailures) / side.trials, show: (value) => value.toFixed(1), change: (delta) => signed(delta, 1) },
];

function failed(failures: readonly ToolFailure[]): number {
  return failures.reduce((sum, failure) => sum + failure.count, 0);
}

function cell(column: Column, row: Row): string {
  const is = row.candidate === null ? null : column.value(row.candidate);

  if (is === null) return '\u2014';
  const was = row.baseline === null ? null : column.value(row.baseline);

  return was === null ? column.show(is) : `${column.show(is)} (${column.change(is - was)})`;
}

function measuresTable(comparison: EvalComparison): string[] {
  const rows: Row[] = [
    ...comparison.rows.map((row) => ({ name: row.taskId, baseline: row.baseline, candidate: row.candidate })),
    { name: '**Run**', baseline: comparison.overall.baseline, candidate: comparison.overall.candidate },
  ];

  return [
    `| Task | ${COLUMNS.map((column) => column.title).join(' | ')} |`, `| --- | ${COLUMNS.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.name} | ${COLUMNS.map((column) => cell(column, row)).join(' | ')} |`),
  ];
}

/** Failed tool calls by tool and cause over every trial, production → candidate, most on the candidate first. */
function failuresTable(comparison: EvalComparison): string[] {
  const { baseline, candidate } = comparison.overall;
  const key = (failure: ToolFailure) => `${failure.tool}\u0000${failure.cause}`;
  const before = new Map((baseline?.toolFailures ?? []).map((failure) => [key(failure), failure.count]));
  const after = new Map(candidate.toolFailures.map((failure) => [key(failure), failure.count]));
  const keys = [...new Set([...after.keys(), ...before.keys()])];

  if (keys.length === 0) return ['No tool call failed on either side.'];

  return [
    '| Tool | Cause | Production | Candidate |', '| --- | --- | --- | --- |',
    ...keys.map((at) => {
      const [tool = '', cause = ''] = at.split('\u0000');

      return `| \`${tool}\` | ${cause} | ${baseline === null ? '\u2014' : String(before.get(at) ?? 0)} | ${String(after.get(at) ?? 0)} |`;
    }),
  ];
}

function planTable(comparison: EvalComparison): string[] {
  const { baseline, candidate } = comparison.overall;
  const windows = [...candidate.planUsage, ...(baseline?.planUsage ?? []).filter((window) => !candidate.planUsage.some((held) => held.account === window.account && held.measure === window.measure))];

  if (windows.length === 0) return ['No call reported a plan window: every model this run used is priced per token.'];

  const used = (side: EvalStats | null, account: string, measure: string) => {
    const window = side?.planUsage.find((held) => held.account === account && held.measure === measure);

    return window === undefined ? '\u2014' : `${window.from.toFixed(0)}% \u2192 ${window.to.toFixed(0)}% (${signed(window.to - window.from, 0, ' pp')})`;
  };

  return [
    '| Account | Window | Production | Candidate |', '| --- | --- | --- | --- |',
    ...windows.map(({ account, measure }) => `| ${account} | ${measure} | ${used(baseline, account, measure)} | ${used(candidate, account, measure)} |`),
  ];
}

function bugs(side: TaskPlatform | null): string {
  if (side === null) return '\u2014';

  return `${String(side.bugTrials)}/${String(side.trials)}: ${String(side.exceptions)} thrown, ${String(side.exceeded)} over limits, `
    + `${String(side.idleWakes)} idle wakes, ${String(side.canceled)} cancelled`;
}

function platformTable(comparison: EvalComparison): string[] {
  const { platform } = comparison;

  if (platform === null) return ['Workers Logs were not read for this run.'];

  const unread = [['Production', platform.why.baseline], ['Candidate', platform.why.candidate]]
    .flatMap(([side, why]) => why === null ? [] : [`${side ?? ''}'s logs were not read: ${why ?? ''}.`]);

  return [
    ...unread, ...unread.length > 0 ? [''] : [],
    '| Task | Production | Candidate | Most frequent failure on the candidate |', '| --- | --- | --- | --- |',
    ...platform.tasks.map(({ taskId, baseline, candidate, pValue }) => {
      const top = candidate?.failures[0];

      return `| ${taskId} | ${bugs(baseline)} | ${bugs(candidate)}${pValue === null ? '' : ` (p = ${pValue.toFixed(2)})`} | `
        + `${top === undefined ? '\u2014' : `\`${top.event}\` ${top.code} \u00d7${String(top.count)}`} |`;
    }),
  ];
}

/** The run report's section of the results comment. */
export function renderRunReport(comparison: EvalComparison): string[] {
  return [
    '## The run, measured', '',
    'Per task and for the whole run, each value with its change against production in parentheses: the mean per trial, '
      + 'but for the pass rate, the slowest trial and the steady prompt cache, which pools every request but each actor\u2019s '
      + 'first; its p5 is the fifth percentile of those requests\u2019 own rates.', '',
    ...measuresTable(comparison), '',
    '### Failed tool calls, by tool and cause', '',
    ...failuresTable(comparison), '',
    '### Plan use', '',
    ...planTable(comparison), '',
    '### Platform bugs in the run\u2019s workspaces', '',
    'Trials whose workspace saw an invocation that threw, one the platform ended for what it spent, or an alarm with nothing '
      + 'to do, from Workers Logs; a significant rise is a regression.', '',
    ...platformTable(comparison), '',
  ];
}
