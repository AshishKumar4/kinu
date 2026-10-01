import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { encodeModelMessageValues, JsonValueSchema, RunEventSchema, type JsonValue, type RunEvent } from '@kinu.run/core';
import { extractInsights, type TrialEvidence } from './insights';
import { parseResults, trials, type Assertion } from './results';

// Selected rows retain their original file/line provenance; fixtures/insights.json was scrubbed with redactJson.
const TrialFixture = v.object({ ledger: v.array(JsonValueSchema), timeline: v.array(JsonValueSchema), transcript: v.string(), assertion: JsonValueSchema });

const fixture = v.parse(v.object({ tool: TrialFixture, orchestration: TrialFixture,
  snapshot: v.object({ value: JsonValueSchema }), stream: v.object({ value: JsonValueSchema }) }),
JSON.parse(readFileSync(new URL('./fixtures/insights.json', import.meta.url), 'utf8')));

type TrialFixture = v.InferOutput<typeof TrialFixture>;

function assertionOf(sample: TrialFixture): Assertion {
  const assertion = trials(parseResults('fixture', JSON.stringify({ testResults: [{ name: 'fixture.eval.ts', assertionResults: [sample.assertion] }] })))[0];

  if (assertion === undefined) throw new Error('fixture has no assertion');

  return assertion;
}

function evidenceOf(sample: TrialFixture, ledger: readonly (JsonValue | RunEvent)[] = sample.ledger): TrialEvidence {
  return { ledger: ledger.map((row) => JSON.stringify(row)).join('\n'), timeline: sample.timeline.map((row) => JSON.stringify(row)).join('\n'), transcript: sample.transcript };
}

function helperSnapshot(value: JsonValue): Assertion {
  const assertion = assertionOf(fixture.orchestration);
  const run = assertion.meta.harness.run;

  return { ...assertion, status: 'failed', meta: { harness: { run: { ...run, output: { ...run.output,
    turns: [{ outcome: { status: 'completed' }, checks: [{ id: 'two-helpers-each-finished-a-tally', pass: false, evidence: value }] }] },
  } } } };
}

const toolRows = fixture.tool.ledger.map((row) => v.parse(RunEventSchema, row));

const start = toolRows.find((row) => row.type === 'run_start');

const call = toolRows.find((row) => row.type === 'tool_call_end');

const end = toolRows.find((row) => row.type === 'run_end');

if (start === undefined || call === undefined || end === undefined) throw new Error('tool fixture lacks a complete run');

const orchestration = extractInsights(assertionOf(fixture.orchestration), evidenceOf(fixture.orchestration));

function toolFacts(rows: readonly RunEvent[]) {
  return extractInsights(assertionOf(fixture.tool), evidenceOf(fixture.tool, rows)).facts;
}

describe('deterministic trial insights', () => {
  test('counts actual call rows and their refusal code, not partial snapshots or results-row totals', () => {
    const partial = { type: 'step_partial', runId: start.runId, toolCalls: [{ toolName: 'file', result: 'duplicate snapshot' }] };
    const insights = extractInsights(assertionOf(fixture.tool), evidenceOf(fixture.tool, [start, call, partial, end]));
    expect(insights.facts.find((fact) => fact.kind === 'tool-calls')).toMatchObject({ data: { tool: 'file', calls: 1, errors: 1 } });
    expect(insights.facts.find((fact) => fact.kind === 'tool-errors')).toMatchObject({
      data: { tool: 'file', code: 'missing', kind: 'refusal', count: 1 }, evidence: [{ file: 'ledger.jsonl', line: 2 }],
    });
  });

  test('finds identical failed inputs despite object-key order and cites both calls', () => {
    const repeat = { ...call, toolCallId: 'repeat', args: { path: 'slates', action: 'list' } };
    expect(toolFacts([start, call, repeat, end]).find((fact) => fact.kind === 'failing-call-loop')).toMatchObject({
      data: { tool: 'file', count: 2 }, evidence: [{ file: 'ledger.jsonl', line: 2 }, { file: 'ledger.jsonl', line: 3 }],
    });
  });

  test('a successful recovery or a new run is not one failing-call loop', () => {
    const success: RunEvent = { ...call, toolCallId: 'recovery', result: [], outcome: { success: true }, error: undefined };
    expect(toolFacts([start, call, success, call, end]).filter((fact) => fact.kind === 'failing-call-loop')).toEqual([]);
    const next = { ...start, runId: 'next-run' };
    expect(toolFacts([start, call, end, next, { ...call, runId: next.runId }, { ...end, runId: next.runId }])
      .filter((fact) => fact.kind === 'failing-call-loop')).toEqual([]);
  });

  test('digests are not identical inputs: full step messages distinguish calls with the same truncated prefix', () => {
    const first = { ...call, args: 'same truncated input…' };
    const second = { ...call, toolCallId: 'second', args: 'same truncated input…' };

    const step: RunEvent = { ...end, type: 'step_finish', stepIndex: 1, messages: encodeModelMessageValues([{
      role: 'assistant', content: [
        { type: 'tool-call', toolName: 'file', toolCallId: first.toolCallId, input: { action: 'list', path: '/one' } },
        { type: 'tool-call', toolName: 'file', toolCallId: second.toolCallId, input: { action: 'list', path: '/two' } },
      ],
    }]) };

    expect(toolFacts([start, first, second, step, end]).filter((fact) => fact.kind === 'failing-call-loop')).toEqual([]);
  });

  test('successful hires are helpers, while refused hire attempts remain tool errors', () => {
    expect(orchestration.facts.filter((fact) => fact.kind === 'helper-hired').map((fact) => fact.data)).toEqual([
      expect.objectContaining({ helper: 'task-sxlr43' }), expect.objectContaining({ helper: 'task-m5eb6d' }),
      expect.objectContaining({ helper: 'task-6gm49z' }), expect.objectContaining({ helper: 'task-n105i0' }),
    ]);
    expect(orchestration.facts.find((fact) => fact.kind === 'tool-errors')).toMatchObject({ data: { tool: 'agents', code: 'bad_input', count: 2 } });
  });

  test('records existing-helper messages and the product delivery outcome', () => {
    expect(orchestration.facts.filter((fact) => fact.kind === 'helper-message').map((fact) => fact.data)).toEqual([
      expect.objectContaining({ helper: 'task-sxlr43', action: 'hire', delivery: 'starts_now' }),
      expect.objectContaining({ helper: 'task-m5eb6d', action: 'hire', delivery: 'starts_now' }),
    ]);
  });

  test('each helper keeps the inspector runs and their error outcomes; not recorded does not mean zero runs', () => {
    const facts = extractInsights(helperSnapshot(fixture.snapshot.value), evidenceOf(fixture.orchestration)).facts;
    expect(facts.find((fact) => fact.kind === 'helper-runs' && v.is(v.object({ helper: v.literal('task-1kpzq9') }), fact.data)))
      .toMatchObject({ data: { status: 'awaiting_input', runs: [expect.objectContaining({ status: 'error' }), expect.objectContaining({ status: 'error' })] } });
    expect(orchestration.facts.find((fact) => fact.kind === 'helper-runs')).toMatchObject({ data: { runs: null } });
    expect(orchestration.facts.filter((fact) => fact.kind === 'idle-helper')).toEqual([]);
  });

  test('an observed idle helper with a recorded empty run list is distinguished from an errored helper', () => {
    const snapshots = { helpers: [{ name: 'task-sxlr43', status: 'idle', runs: [] },
      { name: 'task-m5eb6d', status: 'awaiting_input', runs: [{ status: 'error', asked: 'Average ratings.' }] }] };

    const facts = extractInsights(helperSnapshot(snapshots), evidenceOf(fixture.orchestration)).facts;
    expect(facts.filter((fact) => fact.kind === 'idle-helper').map((fact) => fact.data)).toEqual([{ helper: 'task-sxlr43' }]);
  });

  test('identical briefs sent to distinct helpers expose duplicated delegation, not a retry to the same helper', () => {
    expect(orchestration.facts.filter((fact) => fact.kind === 'duplicated-delegation').map((fact) => fact.data)).toEqual([
      expect.objectContaining({ helpers: ['task-sxlr43', 'task-6gm49z'] }),
      expect.objectContaining({ helpers: ['task-m5eb6d', 'task-n105i0'] }),
    ]);
  });

  test('records the lead writing a delegated output, without treating a read of that output as delegated work', () => {
    expect(orchestration.facts.find((fact) => fact.kind === 'lead-delegated-work')).toMatchObject({ data: {
      helper: 'task-sxlr43', paths: ['/home/user/reports/signups-by-country.json'], tool: 'shell',
    } });

    const rows = fixture.orchestration.ledger.map((value) => {
      const row = v.parse(RunEventSchema, value);

      return row.type === 'tool_call_end' && row.name === 'shell'
        ? { ...row, args: { command: 'cat /home/user/reports/signups-by-country.json /home/user/reports/ratings-by-theme.json' } } : row;
    });

    expect(extractInsights(assertionOf(fixture.orchestration), evidenceOf(fixture.orchestration, rows)).facts
      .filter((fact) => fact.kind === 'lead-delegated-work')).toEqual([]);
  });

  test('report-triggered continuation is observed waiting; no report in the evidence is not a claim of never waiting', () => {
    expect(orchestration.facts.find((fact) => fact.kind === 'lead-report-wait')).toMatchObject({ data: { observed: 'no-report-recorded', reportRuns: [] } });
    let afterLeadEnd = false;

    const rows = fixture.orchestration.ledger.map((value) => {
      const row = v.parse(RunEventSchema, value);

      if (row.type === 'run_end') afterLeadEnd = true;

      return row.type === 'run_start' && afterLeadEnd ? { ...row, caused_by: 'subordinate_report' } : row;
    });

    expect(extractInsights(assertionOf(fixture.orchestration), evidenceOf(fixture.orchestration, rows)).facts
      .find((fact) => fact.kind === 'lead-report-wait')).toMatchObject({ data: { observed: 'resumed-on-report' } });
  });

  test('a refused swarm call retains its outcome and is not counted as a hired helper', () => {
    const swarm: RunEvent = { ...call, name: 'agents', args: { action: 'swarm', task: 'Build the exchange.' }, outcome: { success: false, reason: 'bad_input' } };
    const facts = toolFacts([start, swarm, end]);
    expect(facts.find((fact) => fact.kind === 'swarm-run')).toMatchObject({ data: { outcome: 'failed', code: 'bad_input' } });
    expect(facts.filter((fact) => fact.kind === 'helper-hired')).toEqual([]);
  });

  test('whole turns with no tools remain distinct from the final no-tool step of a turn that did work', () => {
    const empty = orchestration.facts.filter((fact) => fact.kind === 'no-tool-turn');
    expect(empty.map((fact) => fact.data)).toEqual([
      expect.objectContaining({ causedBy: 'task_reminder', steps: 1, outcome: 'completed' }),
      expect.objectContaining({ causedBy: 'chat', steps: 1, outcome: 'completed' }),
      expect.objectContaining({ causedBy: 'task_reminder', steps: 1, outcome: 'completed' }),
    ]);
    expect(toolFacts([start, call, { ...end, type: 'step_finish', stepIndex: 1 }, end]).filter((fact) => fact.kind === 'no-tool-turn')).toEqual([]);
  });

  test('provider throttling, an unproven run error and an actual stream drop retain separate evidence lines', () => {
    const wait: RunEvent = { ...start, type: 'provider_wait', provider: 'opencode-go', waitMs: 800, attempt: 1, status: 429, source: 'backoff' };
    const evidence = evidenceOf(fixture.tool, [start, wait, { ...end, reason: 'error', error: 'Provider refused the model call.' }]);
    evidence.timeline += `\n${JSON.stringify(fixture.stream.value)}`;
    const facts = extractInsights(assertionOf(fixture.tool), evidence).facts;
    expect(facts.find((fact) => fact.kind === 'provider-wait')).toMatchObject({ data: { status: 429, waitMs: 800 }, evidence: [{ file: 'ledger.jsonl', line: 2 }] });
    expect(facts.find((fact) => fact.kind === 'provider-error')).toMatchObject({ data: { error: 'Provider refused the model call.' }, evidence: [{ file: 'ledger.jsonl', line: 3 }] });
    expect(facts.find((fact) => fact.kind === 'stream-drop')).toMatchObject({ data: { mark: 'chunk:closed 1006' }, evidence: [{ file: 'timeline.jsonl', line: 9 }] });
  });

  test('the first failing check follows turn/check order, and links to the actual transcript line', () => {
    const facts = extractInsights(assertionOf(fixture.tool), evidenceOf(fixture.tool)).facts;
    expect(facts.find((fact) => fact.kind === 'first-failing-check')).toMatchObject({
      data: { turn: 2, id: 'resting-orders-survive-the-change' }, evidence: [expect.objectContaining({ file: 'results.json' }), { file: 'transcript.md', line: 11 }],
    });
  });

  test('code-mode writes name delegated paths, while reads, examples and comments do not', () => {
    for (const [code, wrote] of [
      ['await workspace.writeFile("/home/user/reports/signups-by-country.json", "{}");', true],
      ['await workspace.readFile("/home/user/reports/signups-by-country.json");', false],
      ['// workspace.writeFile("/home/user/reports/signups-by-country.json", "{}");', false],
    ] as const) {
      const rows = fixture.orchestration.ledger.map((value) => {
        const row = v.parse(RunEventSchema, value);

        return row.type === 'tool_call_end' && row.name === 'shell' ? { ...row, name: 'eval', args: { code } } : row;
      });

      const facts = extractInsights(assertionOf(fixture.orchestration), evidenceOf(fixture.orchestration, rows)).facts;
      expect(facts.some((fact) => fact.kind === 'lead-delegated-work')).toBe(wrote);
    }
  });

  test('a caught code-mode binding refusal keeps its code without turning the outer successful call into an error', () => {
    const recovered: RunEvent = { ...call, name: 'eval', error: undefined, outcome: { success: true, failures: [
      { success: false, tool: 'file', action: 'edit', reason: 'unread', error: 'The file has not been read.' },
    ] } };

    const facts = toolFacts([start, recovered, end]);
    expect(facts.find((fact) => fact.kind === 'tool-calls')).toMatchObject({ data: { tool: 'eval', calls: 1, errors: 0 } });
    expect(facts.find((fact) => fact.kind === 'tool-errors')).toMatchObject({ data: { tool: 'file', code: 'unread', kind: 'binding-refusal', count: 1 } });
  });
});
