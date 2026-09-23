/** D26: the SDK start block runs the hook through `callOnStart`, which suspends the outer client's
 * timers, ends the alarm loop's wait and opens the hook's control client inside the block; no
 * other input block reaches a container RPC. Red on D8's shape (hook after the block), on
 * upstream's (hook in the block on the connection already open), and on each missing piece. */
import { expect, test } from 'bun:test';
import { auditBlockBodies, containerBlockSources } from './do-init-gate';
import { readSources } from './sources';

const check = (...sources: string[]) => auditBlockBodies(new Map(sources.map((source, index) => [`fixture-${String(index)}.ts`, source])));

const ENDS_ALARM_WAIT = 'callOnStart() { if (this.timeout) { clearTimeout(this.timeout); this.resolve?.(); } return this.onStart(); }';

const container = (block: string, after = '', callOnStart = ENDS_ALARM_WAIT) => `class Container {
  async startAndWaitForPorts() { await this.ctx.blockConcurrencyWhile(async () => { ${block} }); ${after} }
  async start() { await this.ctx.blockConcurrencyWhile(async () => { ${block} }); ${after} }
  ${callOnStart}
}`;

const sandbox = (suspend = 'outer.suspendTimers?.();', rotate = 'this.client = hook;') => `class Sandbox extends Container {
  async callOnStart() {
    const outer = this.client;
    ${suspend}
    const hook = this.createClientForTransport(this.transport);
    ${rotate}
    try { await super.callOnStart(); } finally { this.client = outer; hook.disconnect(); outer.resumeTimers?.(); }
  }
}`;

const BOX = `class Box extends Sandbox { async onStart() { await this.rawExec('cat boot'); } }`;

const IN_BLOCK = 'await this.state.setHealthy(); await this.callOnStart();';

test('direct, returned, local-method and virtual-hook container awaits are red', () => {
  for (const operation of ['await this.exec("cat boot")', 'return this.exec("cat boot")', 'await this.adopt()', 'return this.onStart()', 'await runRestoreStep(100, async () => { await this.adopt(); })']) {
    expect(check(`class Box {
      write() { return this.ctx.blockConcurrencyWhile(async () => { ${operation}; }); }
      async adopt() { await this.readBoot(); }
      async readBoot() { await this.rawExec('cat boot'); }
      async onStart() { await this.adopt(); }
    }`).violations.length).toBeGreaterThan(0);
  }
});

test('the hook inside the start block, isolated from timers set before it, is green', () => {
  const audited = check(container(IN_BLOCK), sandbox(), BOX);

  expect(audited.violations).toEqual([]);
  expect(audited.hookBlocks).toEqual(['start', 'startAndWaitForPorts']);
  expect(audited.hookConnection).toEqual({ file: 'fixture-1.ts', line: 2 });
  expect(audited.alarmWait).toEqual({ file: 'fixture-0.ts', line: 4 });
});

test("D8's shape, the hook after a storage-only start block, is red", () => {
  const audited = check(container('await this.state.setHealthy();', 'await this.onStart();'), sandbox(), BOX);

  expect(audited.hookBlocks).toEqual([]);
  expect(audited.violations.map((found) => found.owner).sort()).toEqual(['start', 'startAndWaitForPorts']);
});

test("upstream's start block, the hook on the connection already open, is red", () => {
  const audited = check(container('await this.state.setHealthy(); await this.onStart();'), BOX);

  expect(audited.violations.some((found) => found.member === 'rawExec')).toBe(true);
});

test('a callOnStart that keeps the client opened before the block is red', () => {
  const audited = check(container(IN_BLOCK), sandbox(undefined, ''), BOX);

  expect(audited.hookConnection).toBeNull();
  expect(audited.violations.some((found) => found.member === 'callOnStart')).toBe(true);
});

test("a callOnStart that leaves the outer client's timers running is red", () => {
  const audited = check(container(IN_BLOCK), sandbox(''), BOX);

  expect(audited.hookConnection).toBeNull();
  expect(audited.violations.some((found) => found.member === 'callOnStart')).toBe(true);
});

test("a start block that leaves the alarm loop's wait armed is red", () => {
  const audited = check(container(IN_BLOCK, '', 'callOnStart() { return this.onStart(); }'), sandbox(), BOX);

  expect(audited.alarmWait).toBeNull();
  expect(audited.violations.some((found) => found.member === 'clearTimeout')).toBe(true);
});

test('a callback parameter cannot put a container RPC into a storage block', () => {
  expect(check(`class Box {
    go() { return this.write(async () => { await this.rawExec('cat boot'); }); }
    write(apply) { return this.ctx.blockConcurrencyWhile(async () => { await apply(); }); }
  }`).violations.length).toBeGreaterThan(0);
});

test('the installed SDK runs the hook in both start blocks, isolated from timers set before them', () => {
  const sources = containerBlockSources(readSources());
  expect([...sources].some(([file]) => file.endsWith('/lib/container.js'))).toBe(true);
  const audited = auditBlockBodies(sources);

  expect(audited.violations).toEqual([]);
  expect(audited.hookBlocks).toEqual(['start', 'startAndWaitForPorts']);
  expect(audited.hookConnection).not.toBeNull();
  expect(audited.alarmWait).not.toBeNull();
});
