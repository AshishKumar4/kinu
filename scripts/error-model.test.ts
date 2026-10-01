/**
 * `gate:error-model` over fixture sources: each mechanism is counted where it appears and not where
 * the target model spells the same word; a planted site is red and `--lock` refuses it; a new file
 * starts at zero; a removed site is green and stale, and `--lock` lowers the number; a declared
 * boundary file grows freely in the mechanisms it declares and in no other.
 */

import { expect, test } from 'bun:test';

import { bridgeSites, type ErrorModelLock, judge, lower, measure } from './error-model';

const FILE = 'packages/fixture/src/a.ts';

const LEGACY = `
export class Gone extends Error {}
export class Deeper extends Gone {}
export class Refused extends KinuError {}
export function read(load: () => Promise<string>): Promise<{ ok: true; text: string } | { ok: false }> {
  try {
    if (Math.random() > 1) throw new Gone('x');
  } catch (error) {
    return Promise.reject(error);
  }
  return load().then((text) => ({ ok: true, text }), () => ({ ok: false })).catch(() => ({ ok: false }));
}
`;

/** The target model's own spellings of the same words: none of these is a legacy site. */
const TARGET = `
declare const program: Effect.Effect<string, KinuError>;
export const handled = program.pipe(Effect.catch(() => Effect.succeed('')));
export class Probe extends Data.TaggedError('Probe') {}
export const unrelated = { okay: true, success: 'yes' };
`;

const lockOf = (counts: Readonly<Record<string, number>>): ErrorModelLock => ({ measuredAt: '2026-09-23', counts });

const measured = (text: string, extra: readonly (readonly [string, string])[] = []) => measure(new Map([[FILE, text], ...extra]));

const BASELINE = lockOf(Object.fromEntries(measured(LEGACY).map(({ key, value }) => [key, value])));

test('each mechanism is counted where it appears, and not where the target model spells the same word', () => {
  expect(Object.fromEntries(measured(LEGACY).map(({ key, value }) => [key.slice(FILE.length + 1), value]))).toEqual({
    'catch': 1,
    'error-class': 3,
    'promise-rejection': 3,
    'result-literal': 3,
    'result-type': 2,
    'throw': 1,
  });
  expect(measured(TARGET)).toEqual([]);
});

test('a planted result literal is over its number, and --lock refuses to record it', () => {
  const grown = measured(`${LEGACY}\nexport const planted = { ok: false };\n`);

  expect(judge(grown, BASELINE).over).toEqual([{ key: `${FILE}#result-literal`, was: 3, now: 4 }]);
  expect(lower(BASELINE, grown, '2026-09-24')).toEqual({
    lock: undefined,
    refusals: [{ key: `${FILE}#result-literal`, was: 3, now: 4 }],
  });
});

test('a new file starts at zero: one throw in it is red', () => {
  const fresh = measured(LEGACY, [['packages/fixture/src/new.ts', 'export function f(): never { throw new Error("x"); }\n']]);

  expect(judge(fresh, BASELINE).over).toEqual([{ key: 'packages/fixture/src/new.ts#throw', was: undefined, now: 1 }]);
  expect(lower(BASELINE, fresh, '2026-09-24').lock).toBeUndefined();
});

test('a stray throw in the standalone devbox library is red and cannot grow its lock', () => {
  const file = 'packages/devbox/src/stray.ts';
  const sites = measure(new Map([[file, 'export function run() { throw new Error("not in the channel"); }']]));
  expect(judge(sites, lockOf({})).over).toEqual([{ key: file + '#throw', was: undefined, now: 1 }]);
  expect(lower(lockOf({}), sites, '2026-09-29').lock).toBeUndefined();
});

test('the library runner cannot execute in a private helper', () => {
  const file = 'packages/devbox/src/runner.ts';

  const source = `import { settle } from "./errors";
export class Box { #private() { return settle(program); } read() { return settle(program); } }`;

  const sites = bridgeSites(new Map([[file, source]]));
  expect(sites.bridges).toEqual([file + ':2']);
  expect(sites.findings).toEqual([file + ':2: a runner returned outside an exported function or public member']);
});

test('a removed site is green with a stale row, and --lock lowers the number', () => {
  const cut = measured(LEGACY.replace('.catch(() => ({ ok: false }))', ''));
  const verdict = judge(cut, BASELINE);

  expect(verdict.over).toEqual([]);
  expect(verdict.stale).toEqual([
    { key: `${FILE}#promise-rejection`, was: 3, now: 2 },
    { key: `${FILE}#result-literal`, was: 3, now: 2 },
  ]);
  expect(lower(BASELINE, cut, '2026-09-24').lock?.counts).toMatchObject({
    [`${FILE}#promise-rejection`]: 2,
    [`${FILE}#result-literal`]: 2,
  });
});

test('the boundary file grows in the mechanisms it declares and in no other', () => {
  const boundary = 'packages/core/src/obs/effect.ts';
  const outcome = 'packages/core/src/tools/outcome.ts';
  const body = 'export const w = { ok: true, success: false }; export function f(): never { throw new Error("x"); }\n';
  const keysOf = (file: string) => measured(LEGACY, [[file, body]]).filter(({ key }) => key.startsWith(file));

  expect(keysOf(boundary)).toEqual([]);
  expect(keysOf(outcome)).toEqual([{ key: `${outcome}#throw`, value: 1 }]);
});

test('a declaration scoped `within` names covers sites inside those names and no others', () => {
  const file = 'packages/core/src/providers/model-test.ts';
  const body = 'export function testModel() { return { ok: true }; }\nexport function other() { return { ok: false }; }\n';

  expect(measured(LEGACY, [[file, body]]).filter(({ key }) => key.startsWith(file))).toEqual([{ key: `${file}#result-literal`, value: 1 }]);
});

test('`settleSync` as a transactionSync callback\'s whole return is a bridge; anywhere else in the callback it is a finding', () => {
  const source = `
import { settle, settleSync } from '../obs/index';
declare const db: { transactionSync<T>(write: () => T): T };
declare function transactionSync<T>(write: () => T): T;
function commitA(): number { return db.transactionSync(() => settleSync(writeEffect())); }
function commitB(): number { return transactionSync(() => { return settleSync(writeEffect()); }); }
function midway(): number { return db.transactionSync(() => { const n = settleSync(writeEffect()); return n; }); }
function wrapped(): number { return db.transactionSync(() => Number(settleSync(writeEffect()))); }
function asyncRunner(): Promise<number> { return db.transactionSync(() => settle(writeEffect())); }
function nested(): number { return db.transactionSync(() => [1].map(() => settleSync(writeEffect()))[0] ?? 0); }
function ordinary(): number { const n = settleSync(writeEffect()); return n; }
`;

  expect(bridgeSites(new Map([[FILE, source]]))).toEqual({
    bridges: [`${FILE}:5`, `${FILE}:6`],
    findings: [
      `${FILE}:10: a runner returned outside an exported function or public member`,
      `${FILE}:11: a runner called mid-body; the effect is run once, at the edge, as its return`,
      `${FILE}:7: a runner called mid-body; the effect is run once, at the edge, as its return`,
      `${FILE}:8: a runner called mid-body; the effect is run once, at the edge, as its return`,
      `${FILE}:9: a runner returned outside an exported function or public member`,
    ],
  });
});

test('a bridge is `return settle(…)` or `return settleSync(…)` from an exported function or public member; elsewhere it is a finding', () => {
  const bridged = `
import { settle, settleSync as run } from '../obs/index';
export function parse(text: string): number { return run(parseEffect(text)); }
export async function load(): Promise<string> { return await settle(loadEffect()); }
export const read = (): number => { return run(readEffect()); };
export class Store {
  open(): number { return run(openEffect()); }
  private helper(): number { return run(helperEffect()); }
}
function local(): number { return run(localEffect()); }
export function seam(): { open(): number } { return { open() { return run(openEffect()); } }; }
function hidden(): { open(): number } { return { open() { return run(openEffect()); } }; }
export function mapped(): Promise<{ open(): number }> { return settle(Effect.map(keyEffect(), () => ({ open() { return run(openEffect()); } }))); }
export class Seams { readonly seam = { deploy: (r: number) => settle(deployEffect(r)) }; }
const hiddenSeam = { deploy: (r: number) => settle(deployEffect(r)) };
export function midway(): number { const n = run(countEffect()); return n + 1; }
export function inner(): Effect.Effect<number, KinuError> { return Effect.succeed(1); }
`;

  // A local \`settle\` is not the runner, and a runner that is not returned is not the bridge shape.
  const local = `
function settle(value: number): number { return value; }
export function done(): number { return settle(1); }
`;

  expect(bridgeSites(new Map([[FILE, bridged], ['packages/fixture/src/b.ts', local]]))).toEqual({
    bridges: [`${FILE}:11`, `${FILE}:13`, `${FILE}:13`, `${FILE}:14`, `${FILE}:3`, `${FILE}:4`, `${FILE}:5`, `${FILE}:7`],
    findings: [
      `${FILE}:10: a runner returned outside an exported function or public member`,
      `${FILE}:12: a runner returned outside an exported function or public member`,
      `${FILE}:15: a runner returned outside an exported function or public member`,
      `${FILE}:16: a runner called mid-body; the effect is run once, at the edge, as its return`,
      `${FILE}:8: a runner returned outside an exported function or public member`,
    ],
  });
});
