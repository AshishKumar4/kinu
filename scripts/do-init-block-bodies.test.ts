/** Cloud 2026-09-13, b20260913105359: SDK block :641 awaited onStart :644;
 * boot-id RPC :3495 never answered. Controls and raw trace are in that run. */
import { expect, test } from 'bun:test';
import { auditBlockBodies, containerBlockSources } from './do-init-gate';
import { readSources } from './sources';

const check = (source: string) => auditBlockBodies(new Map([['fixture.ts', source]]));

test('direct, returned, local-method and virtual-hook container awaits are red', () => {
  for (const operation of ['await this.exec("cat boot")', 'return this.exec("cat boot")', 'await this.adopt()', 'return this.onStart()', 'await runRestoreStep(100, async () => { await this.adopt(); })']) {
    expect(check(`class Box {
      start() { return this.ctx.blockConcurrencyWhile(async () => { ${operation}; }); }
      async adopt() { await this.readBoot(); }
      async readBoot() { await this.rawExec('cat boot'); }
      async onStart() { await this.adopt(); }
    }`).length).toBeGreaterThan(0);
  }
});

test('storage-only blocks with the awaited hook outside are green', () => {
  expect(check(`class Box {
    async start() { await this.ctx.blockConcurrencyWhile(async () => {
      await this.activate(); this.ctx.storage.sql.exec('SELECT 1');
    }); await this.onStart(); }
    async activate() { await this.ctx.storage.get('boot'); }
    async onStart() { await this.rawExec('cat boot'); }
  }`)).toEqual([]);
});

test('a callback parameter cannot put a container RPC into a storage block', () => {
  expect(check(`class Box {
    go() { return this.write(async () => { await this.rawExec('cat boot'); }); }
    write(apply) { return this.ctx.blockConcurrencyWhile(async () => { await apply(); }); }
  }`).length).toBeGreaterThan(0);
});

test('the installed SDK blocks and product blocks never reach a container RPC', () => {
  const sources = containerBlockSources(readSources());
  expect([...sources].some(([file]) => file.endsWith('/lib/container.js'))).toBe(true);
  expect(auditBlockBodies(sources)).toEqual([]);
});
