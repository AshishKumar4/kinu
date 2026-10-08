import { describe, expect, test } from 'bun:test';
import { encodeModelMessageValues, type JsonValue, type RunEvent } from '@kinu.run/core';
import { extractInsights, type InsightFact, type TrialEvidence } from './insights';
import { assertion, base, end, evidence, missingFile, start } from './fixtures/insight-evidence';
import type { Assertion } from './results';

const REPORT = '/home/user/reports/signups-by-country.json';

// Delegation fields: staging-f3-launch-prep/launch-prep-trial-1/ledger.jsonl:12,24,33,129.
function hire(helper: string, mission = `write ${REPORT}`): Extract<RunEvent, { type: 'tool_call_end' }> {
  return { ...base, type: 'tool_call_end', name: 'agents', toolCallId: helper, args: { op: 'hire', mission }, result: { name: helper }, outcome: { success: true } };
}

function facts(rows: readonly (JsonValue | RunEvent)[], result: Assertion = assertion(), extra: Partial<TrialEvidence> = {}): InsightFact[] {
  return extractInsights(result, evidence(rows, extra)).facts;
}

function helperResult(helpers: JsonValue): Assertion {
  return assertion([{ part: 'build', turn: 1, outcome: { status: 'completed' }, checks: [{ id: 'helpers-finished', pass: false, evidence: { helpers } }] }]);
}

describe('deterministic trial insights', () => {
  test('counts actual call rows and their refusal code, not partial snapshots or results-row totals', () => {
    const partial = { type: 'step_partial', runId: start.runId, toolCalls: [{ toolName: 'file' }] };
    const observed = facts([start, missingFile, partial, end]);
    expect(observed.find((fact) => fact.kind === 'tool-calls')).toMatchObject({ data: { tool: 'file', calls: 1, errors: 1 } });
    expect(observed.find((fact) => fact.kind === 'tool-errors')).toMatchObject({
      data: { tool: 'file', code: 'missing', kind: 'refusal', count: 1 }, evidence: [{ file: 'ledger.jsonl', line: 2 }],
    });
  });

  test('finds identical failed inputs despite object-key order and cites both calls', () => {
    const repeat = { ...missingFile, toolCallId: 'repeat', args: { path: 'slates', op: 'list' } };
    expect(facts([start, missingFile, repeat, end]).find((fact) => fact.kind === 'failing-call-loop')).toMatchObject({
      data: { tool: 'file', count: 2 }, evidence: [{ file: 'ledger.jsonl', line: 2 }, { file: 'ledger.jsonl', line: 3 }],
    });
  });

  test('a successful recovery or a new run is not one failing-call loop', () => {
    const success = { ...missingFile, toolCallId: 'recovery', result: [], outcome: { success: true as const }, error: undefined };
    expect(facts([start, missingFile, success, missingFile, end]).filter((fact) => fact.kind === 'failing-call-loop')).toEqual([]);
    const next = { ...start, runId: 'next' };
    expect(facts([start, missingFile, end, next, { ...missingFile, runId: 'next' }, { ...end, runId: 'next' }])
      .filter((fact) => fact.kind === 'failing-call-loop')).toEqual([]);
  });

  test('digests are not identical inputs: full step messages distinguish calls with the same truncated prefix', () => {
    const first = { ...missingFile, args: 'same truncated input…' };
    const second = { ...missingFile, toolCallId: 'second', args: 'same truncated input…' };

    const step: RunEvent = { ...base, type: 'step_finish', stepIndex: 1, messages: encodeModelMessageValues([{
      role: 'assistant', content: [
        { type: 'tool-call', toolName: 'file', toolCallId: first.toolCallId, input: { op: 'list', path: '/one' } },
        { type: 'tool-call', toolName: 'file', toolCallId: second.toolCallId, input: { op: 'list', path: '/two' } },
      ],
    }]) };

    expect(facts([start, first, second, step, end]).filter((fact) => fact.kind === 'failing-call-loop')).toEqual([]);
  });

  test('successful hires are helpers, while refused hire attempts remain tool errors', () => {
    const refused: RunEvent = { ...hire('refused'), error: 'Use mission, not message.', outcome: { success: false, reason: 'bad_input' } };
    const observed = facts([start, refused, hire('counter'), end]);
    expect(observed.filter((fact) => fact.kind === 'helper-hired').map((fact) => fact.data)).toEqual([expect.objectContaining({ helper: 'counter' })]);
    expect(observed.find((fact) => fact.kind === 'tool-errors')).toMatchObject({ data: { tool: 'agents', code: 'bad_input', count: 1 } });
  });

  test('records existing-helper messages and the product delivery outcome', () => {
    const message: RunEvent = { ...hire('counter'), args: { op: 'assign', agent: 'counter', message: 'Retry the tally.' }, result: { delivery: 'starts_now' } };
    const observed = facts([start, message, end]);
    expect(observed.filter((fact) => fact.kind === 'helper-message').map((fact) => fact.data)).toEqual([
      expect.objectContaining({ helper: 'counter', op: 'assign', delivery: 'starts_now' }),
    ]);
  });

  test('each helper keeps the inspector runs and their error outcomes; not recorded does not mean zero runs', () => {
    // proofs/helpers-check/staging-a4e564ce1.log:4 records two failed runs for this helper.
    const observed = facts([], helperResult([{ name: 'counter', status: 'awaiting_input', runs: [
      { status: 'error', asked: 'Please retry the tally' }, { status: 'error', asked: 'Count the waitlist signups' },
    ] }]));

    expect(observed.find((fact) => fact.kind === 'helper-runs')).toMatchObject({ data: { status: 'awaiting_input', runs: [
      { status: 'error', asked: 'Please retry the tally' }, { status: 'error', asked: 'Count the waitlist signups' },
    ] } });
    const unrecorded = facts([start, hire('counter'), end]);
    expect(unrecorded.find((fact) => fact.kind === 'helper-runs')).toMatchObject({ data: { runs: null } });
    expect(unrecorded.filter((fact) => fact.kind === 'idle-helper')).toEqual([]);
  });

  test('an observed idle helper with a recorded empty run list is distinguished from an errored helper', () => {
    const observed = facts([], helperResult([{ name: 'idle', status: 'idle', runs: [] },
      { name: 'errored', status: 'awaiting_input', runs: [{ status: 'error' }] }, { name: 'waiting', status: 'awaiting_input', runs: [] }]));

    expect(observed.filter((fact) => fact.kind === 'idle-helper').map((fact) => fact.data)).toEqual([{ helper: 'idle' }]);
  });

  test('identical briefs sent to distinct helpers expose duplicated delegation, not a retry to the same helper', () => {
    const retry: RunEvent = { ...hire('counter'), args: { op: 'assign', agent: 'counter', message: `write ${REPORT}` }, result: { delivery: 'starts_now' } };
    const observed = facts([start, hire('counter'), hire('other-counter'), retry, end]);
    expect(observed.filter((fact) => fact.kind === 'duplicated-delegation').map((fact) => fact.data)).toEqual([
      expect.objectContaining({ helpers: ['counter', 'other-counter'] }),
    ]);
  });

  test('records the lead writing a delegated output, without treating a read of that output as delegated work', () => {
    const write: RunEvent = { ...missingFile, name: 'shell', args: { command: `printf '{}' > ${REPORT}` }, error: undefined, outcome: { success: true } };
    expect(facts([start, hire('counter'), write, end]).find((fact) => fact.kind === 'lead-delegated-work')).toMatchObject({
      data: { helper: 'counter', paths: [REPORT], tool: 'shell' },
    });
    const read = { ...write, args: { command: `cat ${REPORT}` } };
    expect(facts([start, hire('counter'), read, end]).filter((fact) => fact.kind === 'lead-delegated-work')).toEqual([]);
  });

  test('report-triggered continuation is observed waiting; no report in the evidence is not a claim of never waiting', () => {
    const hired = [start, hire('counter'), end];
    expect(facts(hired).find((fact) => fact.kind === 'lead-report-wait')).toMatchObject({ data: { observed: 'no-report-recorded', reportRuns: [] } });
    const report = { ...start, runId: 'report', caused_by: 'subordinate_report' };
    expect(facts([...hired, report, { ...end, runId: 'report' }]).find((fact) => fact.kind === 'lead-report-wait')).toMatchObject({
      data: { observed: 'resumed-on-report', reportRuns: ['report'] },
    });
  });

  test('a refused swarm call retains its outcome and is not counted as a hired helper', () => {
    const swarm: RunEvent = { ...hire('swarm'), args: { op: 'swarm', task: 'Build the exchange.' }, error: 'Missing preset.', outcome: { success: false, reason: 'bad_input' } };
    const observed = facts([start, swarm, end]);
    expect(observed.find((fact) => fact.kind === 'swarm-run')).toMatchObject({ data: { outcome: 'failed', code: 'bad_input' } });
    expect(observed.filter((fact) => fact.kind === 'helper-hired')).toEqual([]);
  });

  test('whole turns with no tools remain distinct from the final no-tool step of a turn that did work', () => {
    const step: RunEvent = { ...base, type: 'step_finish', stepIndex: 1 };

    for (const causedBy of ['chat', 'task_reminder']) {
      const observed = facts([{ ...start, caused_by: causedBy }, step, end]);
      expect(observed.filter((fact) => fact.kind === 'no-tool-turn').map((fact) => fact.data)).toEqual([
        expect.objectContaining({ causedBy, steps: 1, outcome: 'completed' }),
      ]);
    }

    expect(facts([start, missingFile, step, end]).filter((fact) => fact.kind === 'no-tool-turn')).toEqual([]);
  });

  test('provider throttling, an unproven run error and an actual stream drop retain separate evidence lines', () => {
    const wait: RunEvent = { ...base, type: 'provider_wait', provider: 'opencode-go', waitMs: 800, attempt: 1, status: 429, source: 'backoff' };
    // baseline-leg-prod-2/site-preview-trial-1/timeline.jsonl:410.
    const timeline = [{ at: 0, mark: 'turn' }, { at: 1790813705121, mark: 'chunk:closed 1006' }].map((row) => JSON.stringify(row)).join('\n');
    const observed = facts([start, wait, { ...end, reason: 'error', error: 'Provider refused the model call.' }], assertion(), { timeline });
    expect(observed.find((fact) => fact.kind === 'provider-wait')).toMatchObject({ data: { status: 429, waitMs: 800 }, evidence: [{ file: 'ledger.jsonl', line: 2 }] });
    expect(observed.find((fact) => fact.kind === 'provider-error')).toMatchObject({ data: { error: 'Provider refused the model call.' }, evidence: [{ file: 'ledger.jsonl', line: 3 }] });
    expect(observed.find((fact) => fact.kind === 'stream-drop')).toMatchObject({ data: { mark: 'chunk:closed 1006' }, evidence: [{ file: 'timeline.jsonl', line: 2 }] });
  });

  test('the first failing check follows turn/check order, and links to the actual transcript line', () => {
    // prod-muse-2/order-book-trial-1/transcript.md:5-11, with unrelated passing checks removed.
    const result = assertion([{ part: 'build', turn: 1, outcome: { status: 'completed' }, checks: [{ id: 'matches-a-day-of-orders', pass: true }] },
      { part: 'build', turn: 2, outcome: { status: 'completed' }, checks: [{ id: 'resting-orders-survive-the-change', pass: false }, { id: 'later-failure', pass: false }] }]);

    const observed = facts([], result, { transcript: 'Turn 1: completed\nTurn 2: completed\n- FAIL `resting-orders-survive-the-change`' });
    expect(observed.find((fact) => fact.kind === 'first-failing-check')).toMatchObject({
      data: { turn: 2, id: 'resting-orders-survive-the-change' }, evidence: [expect.objectContaining({ file: 'results.json' }), { file: 'transcript.md', line: 3 }],
    });
  });

  test('code-mode writes name delegated paths, while reads, examples and comments do not', () => {
    for (const [code, wrote] of [
      [`await workspace.writeFile('${REPORT}', '{}');`, true],
      [`await file.write('${REPORT}', '{}');`, true],
      [`await workspace.readFile('${REPORT}');`, false],
      [`// workspace.writeFile('${REPORT}', '{}');`, false],
    ] as const) {
      const invoked: RunEvent = { ...missingFile, name: 'eval', args: { code }, error: undefined, outcome: { success: true } };
      expect(facts([start, hire('counter'), invoked, end]).some((fact) => fact.kind === 'lead-delegated-work')).toBe(wrote);
    }
  });

  test('a caught code-mode binding refusal keeps its code without turning the outer successful call into an error', () => {
    const recovered: RunEvent = { ...missingFile, name: 'eval', error: undefined, outcome: { success: true, failures: [
      { success: false, tool: 'file', op: 'edit', reason: 'unread', error: 'The file has not been read.' },
    ] } };

    const observed = facts([start, recovered, end]);
    expect(observed.find((fact) => fact.kind === 'tool-calls')).toMatchObject({ data: { tool: 'eval', calls: 1, errors: 0 } });
    expect(observed.find((fact) => fact.kind === 'tool-errors')).toMatchObject({ data: { tool: 'file', code: 'unread', kind: 'binding-refusal', count: 1 } });
  });
});
