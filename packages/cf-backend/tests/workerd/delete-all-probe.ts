/**
 * What a workspace delete leaves behind (m1924): a parent object holding one facet with its own SQLite, wiped by
 * `deleteAll()` alone, or with its facet deleted first as the shipped wipe does.
 */
import { DurableObject } from 'cloudflare:workers';
import type { DeleteAllMeasurement, DeleteAllWipe } from './delete-all-shapes';

const CHILD = `import { DurableObject } from 'cloudflare:workers';
export class Child extends DurableObject {
  put(value) {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS kept (v TEXT)');
    this.ctx.storage.sql.exec('INSERT INTO kept VALUES (?)', value);
  }
  rows() {
    const table = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kept'").toArray();
    return table.length === 0 ? [] : this.ctx.storage.sql.exec('SELECT v FROM kept').toArray().map((row) => String(row.v));
  }
}
`;

interface ChildFacet extends Rpc.DurableObjectBranded {
  put(value: string): void;
  rows(): string[];
}

export class DeleteAllProbeDO extends DurableObject<{ readonly LOADER: WorkerLoader }> {
  private child() {
    const worker = this.env.LOADER.get('delete-all-child', () => ({ compatibilityDate: '2026-09-30', mainModule: 'child.js', modules: { 'child.js': CHILD } }));

    return this.ctx.facets.get<ChildFacet>('child', () => ({ class: worker.getDurableObjectClass('Child') }));
  }

  /** Writes the parent's own row, an alarm and the facet's row; wipes; reads what each kept from a fresh start. */
  async measure(wipe: DeleteAllWipe): Promise<DeleteAllMeasurement> {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mine (v TEXT)');
    this.ctx.storage.sql.exec('INSERT INTO mine VALUES (?)', 'the parent\'s row');
    await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
    await this.child().put('the facet\'s row');
    const facetBefore = await this.child().rows();

    if (wipe === 'facet-then-deleteAll') this.ctx.facets.delete('child');

    if (wipe !== 'none') await this.ctx.storage.deleteAll();
    // A fresh facet start reads its storage, not a live instance's memory.
    this.ctx.facets.abort('child', new Error('the wipe ended this facet'));

    return {
      facetBefore,
      facetAfter: await this.child().rows(),
      parentTables: this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mine'").toArray().length,
      alarmAfter: await this.ctx.storage.getAlarm(),
    };
  }

  alarm(): void {}
}
