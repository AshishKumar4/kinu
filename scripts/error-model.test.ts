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

test.each([
  ['a function it names', 'packages/core/src/providers/model-test.ts', 'result-literal',
    'export function testModel() { return { ok: true }; }\nexport function other() { return { ok: false }; }\n'],
  ['the class it names', 'packages/core/src/types/file-edits.ts', 'error-class',
    'export class FileRefusalError extends KinuError {}\nexport class OtherRefusal extends KinuError {}\n'],
])('a declaration scoped `within` covers %s and not its sibling', (_what, file, mechanism, body) => {
  expect(measured(LEGACY, [[file, body]]).filter(({ key }) => key.startsWith(file))).toEqual([{ key: `${file}#${mechanism}`, value: 1 }]);
});

test('a file may hold two declarations, each covering only its own mechanisms and names', () => {
  const file = 'packages/core/src/tools/db-codemode.ts';

  const body = 'export class AppBatchError extends KinuError {}\nexport class Other extends KinuError {}\n'
    + 'export const tool = { execute() { return { ok: true }; } };\nexport function local() { return { ok: false }; }\n';

  expect(measured(LEGACY, [[file, body]]).filter(({ key }) => key.startsWith(file))).toEqual([
    { key: `${file}#error-class`, value: 1 },
    { key: `${file}#result-literal`, value: 1 },
  ]);
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
    flights: [],
    routes: [],
    held: [],
    react: [],
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
    flights: [],
    routes: [],
    held: [],
    react: [],
    findings: [
      `${FILE}:10: a runner returned outside an exported function or public member`,
      `${FILE}:12: a runner returned outside an exported function or public member`,
      `${FILE}:15: a runner returned outside an exported function or public member`,
      `${FILE}:16: a runner called mid-body; the effect is run once, at the edge, as its return`,
      `${FILE}:8: a runner returned outside an exported function or public member`,
    ],
  });
});

test('a runner a Hono route handler returns is the edge; one mid-body, or in a handler-shaped arrow off a route, is not', () => {
  const source = `
import { Hono } from 'hono';
import { settle } from '../obs/index';
const app = new Hono();
app.get('/a', (c) => settle(read(c)));
app.post('/b', async (c) => { return settle(write(c)); });
app.use(async (c, next) => settle(guard(c, next)));
export const routes = new Hono().get('/c', (c) => settle(read(c))).delete('/d', (c) => settle(drop(c)));
app.put('/e', async (c) => { const n = await settle(read(c)); return json(n); });
app.patch('/f', async (c) => { await settle(first(c)); return settle(second(c)); });
other.get('/g', (c) => settle(read(c)));
queue.on('/h', (c) => settle(read(c)));
app.get((c) => settle(read(c)));
`;

  expect(bridgeSites(new Map([[FILE, source]]))).toEqual({
    bridges: [],
    flights: [],
    routes: [`${FILE}:10`, `${FILE}:5`, `${FILE}:6`, `${FILE}:7`, `${FILE}:8`, `${FILE}:8`],
    held: [],
    react: [],
    findings: [
      `${FILE}:10: a runner called mid-body; the effect is run once, at the edge, as its return`,
      `${FILE}:11: a runner returned outside an exported function or public member`,
      `${FILE}:12: a settle whose caller never awaits it (React, a timer or a listener), so a rejection would float; run the answered effect with detach`,
      `${FILE}:13: a runner returned outside an exported function or public member`,
      `${FILE}:9: a runner called mid-body; the effect is run once, at the edge, as its return`,
    ],
  });
});

test('a flight built once and held is the one mid-body runner; a flight that shares no run is a finding', () => {
  const source = `
import { flight, settle } from '../obs/index';
const boot = flight(bootEffect, { keep: 'success' });
export class Box {
  #start = flight(() => startEffect(this));
  read() { return settle(Effect.andThen(this.#start(), boot())); }
}
export function host() { const opened = flight(openEffect, { key: (r: Ref) => r.id }); return { open: (r: Ref) => settle(opened(r)) }; }
export function once() { const run = flight(onceEffect); return settle(run()); }
export function inline() { return settle(flight(inlineEffect)()); }
export const minted = flight(mintEffect, { key: () => nanoid() });
export const dated = flight(dateEffect, { key: () => Date.now() });
export const counted = flight(countEffect, { key: () => next++ });
export async function mid() { const n = await settle(countEffect()); return n; }
`;

  expect(bridgeSites(new Map([[FILE, source]]))).toEqual({
    bridges: [`${FILE}:10`, `${FILE}:6`, `${FILE}:8`, `${FILE}:9`],
    flights: [`${FILE}:3`, `${FILE}:5`, `${FILE}:8`],
    routes: [],
    held: [],
    react: [],
    findings: [
      `${FILE}:10: a flight called where it is built runs once per call; build it once and hold it`,
      `${FILE}:11: a flight keyed by a fresh value never joins a run; key it by what its callers share`,
      `${FILE}:12: a flight keyed by a fresh value never joins a run; key it by what its callers share`,
      `${FILE}:13: a flight keyed by a fresh value never joins a run; key it by what its callers share`,
      `${FILE}:14: a runner called mid-body; the effect is run once, at the edge, as its return`,
      `${FILE}:9: a flight called where it is built runs once per call; build it once and hold it`,
    ],
  });
});

test('a runner handed straight to a platform holder is a held root; stored first, chained or wrapped, it is a finding', () => {
  const source = `
import { settle } from '../obs/index';
export class Host {
  start(ctx: Ctx, deps: Deps) {
    ctx.waitUntil(settle(warm()));
    this.keepAliveWhile(() => settle(drain()));
    deps.fiber('job', (fiberCtx) => settle(run(fiberCtx)), ({ cause }) => settle(failed(cause)));
    const later = settle(index());
    ctx.waitUntil(later);
    ctx.waitUntil(settle(index()).then(done));
    ctx.waitUntil(Promise.all([settle(a()), settle(b())]));
    this.keepAliveWhile(async () => { await settle(drain()); });
    queue.send(settle(other()));
  }
}
`;

  const midBody = 'a runner called mid-body; the effect is run once, at the edge, as its return';

  expect(bridgeSites(new Map([[FILE, source]]))).toEqual({
    bridges: [],
    flights: [],
    routes: [],
    held: [`${FILE}:5`, `${FILE}:6`, `${FILE}:7`, `${FILE}:7`],
    react: [],
    findings: [`${FILE}:10`, `${FILE}:11`, `${FILE}:11`, `${FILE}:12`, `${FILE}:13`, `${FILE}:8`].map((site) => `${site}: ${midBody}`),
  });
});

// React's positions are read by syntax, not by a file's extension: a hook's `.ts` module hands React an effect's
// callback and a useCallback body as a component does, and a runner anywhere else in it is still a finding.
test('a hook module\'s effect and callback may detach; its top level and plain functions may not', () => {
  const HOOK = 'packages/fixture/src/hooks/use-reads.ts';

  const source = `
import { detach } from '../obs/index';
detach(warm());
export function useReads() {
  useEffect(() => { detach(load()); }, []);
  const reload = useCallback(() => { detach(load()); }, []);
  return reload;
}
function refresh() {
  detach(load());
}
`;

  const only = 'detach runs only where its caller never awaits: a timer, a listener, or a function a component hands out';
  const sites = bridgeSites(new Map([[HOOK, source]]));

  expect({ react: sites.react, findings: sites.findings }).toEqual({
    react: [`${HOOK}:5`, `${HOOK}:6`],
    findings: [`${HOOK}:10: ${only}`, `${HOOK}:3: ${only}`],
  });
});

test('React calls an intrinsic element\'s handler and an effect\'s, where only detach runs; it tracks a transition\'s or action\'s returned settle', () => {
  const TSX = 'packages/fixture/src/panel.tsx';

  const source = `
import { detach, settle, settleSync } from '../obs/index';
function Panel() {
  const save = useCallback(() => detach(write()), []);
  const open = useCallback(() => { return detach(write()); }, []);
  useEffect(() => {
    const controller = new AbortController();
    detach(load(controller.signal));
    return () => { controller.abort(); };
  }, []);
  useEffect(() => detach(load()), []);
  useEffect(() => { void settle(load()); }, []);
  const read = useCallback(() => settle(load()), []);
  const theme = useMemo(() => settleSync(pick()), [registry]);
  const later = () => detach(load());
  const pending = settle(load());
  const dialog = <Dialog onConfirm={() => settle(save())} onClose={() => detach(close())} />;
  const quit = <button onClick={() => settle(save())} />;
  const form = <form action={() => settle(save())} onSubmit={() => startTransition(() => detach(load()))} />;
  const [state, act] = useActionState(() => settle(save()), null);
  const pick = useCallback(() => start(() => settle(load())), []);
  return <button onClick={() => detach(save())} onBlur={(event) => { event.preventDefault(); detach(save()); }} onFocus={() => startTransition(() => settle(load()))} />;
}
`;

  const plain = `
import { detach, settle, settleSync } from '../obs/index';
function helper() {
  useCallback(() => settle(write()), []);
  useCallback(() => detach(write()), []);
  setTimeout(() => settle(drain()), 10);
  globalThis.setInterval(() => detach(poll()), 10);
  queueMicrotask(() => { detach(drain()); });
  socket.addEventListener('message', (event) => detach(read(event)));
  process.on('SIGINT', () => settle(stop()));
  rl.once('line', (line) => detach(answer(line)));
  queue.push(() => detach(drain()));
}
`;

  const midBody = 'a runner called mid-body; the effect is run once, at the edge, as its return';
  const floats = 'a settle whose caller never awaits it (React, a timer or a listener), so a rejection would float; run the answered effect with detach';
  const only = 'detach runs only where its caller never awaits: a timer, a listener, or a function a component hands out';
  const drops = 'detach in a transition or action returns nothing React can track, so its pending state is dropped; return settle(…)';

  expect(bridgeSites(new Map([[TSX, source], [FILE, plain]]))).toEqual({
    bridges: [],
    flights: [],
    routes: [],
    held: [],
    react: [
      `${FILE}:11`, `${FILE}:4`, `${FILE}:5`, `${FILE}:7`, `${FILE}:8`, `${FILE}:9`, `${TSX}:11`, `${TSX}:13`, `${TSX}:14`, `${TSX}:17`, `${TSX}:17`,
      `${TSX}:19`, `${TSX}:20`, `${TSX}:22`, `${TSX}:22`, `${TSX}:22`, `${TSX}:4`, `${TSX}:5`, `${TSX}:8`,
    ],
    findings: [
      `${FILE}:10: ${floats}`,
      `${FILE}:12: ${only}`,
      `${FILE}:6: ${floats}`,
      `${TSX}:12: ${midBody}`,
      `${TSX}:15: ${only}`,
      `${TSX}:16: ${midBody}`,
      `${TSX}:18: ${floats}`,
      `${TSX}:19: ${drops}`,
      // A transition start under another name is not recognized, so it stays a finding.
      `${TSX}:21: a runner returned outside an exported function or public member`,
    ],
  });
});
