import { expect, test } from 'bun:test';
import { prototypeSteps } from '../tasks/ephemeral';

// Each call as a trial recorded it (`turnToolCalls`: the tool's name and its arguments as JSON), from the runs named.
const call = (code: string) => ({ name: 'eval', args: JSON.stringify({ code }) });

// offsite-venue trial 1 (eval-base, 2026-10-01): an answer asked to be drawn in the chat, built as a file slate first.
const OFFSITE_PROTOTYPE = call('// Preview the offsite picker slate\nreturn await workspace.slates["offsite-picker"].$preview();');

// latency-chart trial 2 (eval-base2): the same, twice.
const CHART_PROTOTYPE = call('// Preview p95-latency slate\nconst r = await workspace.slates["p95-latency"].$preview();\nreturn r;');

// request-logs trial 1 (deploy-speed go-5x4, passed): the real slate checked as the slates skill asks.
const LOGS_CHECKED = call('// Reload slate after hiding helpers, then verify\nawait workspace.slates.logs.$preview();\n'
  + 'const methods = await workspace.slates.logs.$methods();\nconst days = await workspace.slates.logs.days();');

// budget-board trial 2 (deploy-speed go-5x4): both asked-for slates compiled and their data cleared.
const BUDGET_CHECKED = call('// Reload with wipe, clear test data, verify empty\nawait workspace.slates.ledger.$preview();\n'
  + 'await workspace.slates.board.$preview();\nconst w1 = await workspace.slates.ledger.wipe();');

test('a slate built in place of an answer drawn in the chat is a prototype, in the trials that did it', () => {
  expect(prototypeSteps([OFFSITE_PROTOTYPE], [])).toHaveLength(1);
  expect(prototypeSteps([CHART_PROTOTYPE, CHART_PROTOTYPE], [])).toHaveLength(2);
});

test('the real slate previewed, then looked at, is its check and no prototype, in the trials that did it', () => {
  const looked = { name: 'eval', args: JSON.stringify({ code: 'const { url } = await workspace.slates.logs.$preview();\nreturn await web.screenshot({ url });' }) };

  expect(prototypeSteps([LOGS_CHECKED, looked], ['logs'])).toEqual([]);
  expect(prototypeSteps([BUDGET_CHECKED], ['ledger', 'board'])).toEqual([]);
});

test('a page, server or other slate standing in for the asked-for one is a prototype, whatever checks follow', () => {
  const steps = prototypeSteps([
    { name: 'file', args: JSON.stringify({ op: 'write', path: '/workspace/scratch/board.html', content: '<div></div>' }) },
    { name: 'file', args: JSON.stringify({ op: 'write', path: '/workspace/slates/chess/page.html', content: '<div></div>' }) },
    call('return await workspace.slates["chess-test"].$preview();'),
    { name: 'shell', args: JSON.stringify({ command: 'python3 -m http.server 8000' }) },
    call('return await web.screenshot({ url: "http://localhost:8000" });'),
    call('return await workspace.slates.chess.$preview();'),
  ], ['chess']);

  expect(steps.map((step) => ['scratch/board.html', 'chess-test', 'http.server', 'localhost:8000'].findIndex((mark) => step.includes(mark))))
    .toEqual([0, 1, 2, 3]);
});
