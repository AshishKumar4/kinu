/** The shipped AgentFacet with SQL/RPC meters over the facet's actual SQLite. */
import { AgentFacet as Product } from '../../packages/cf-backend/src/agent-facet/agent-facet';
import { Meter, instrument, type Slice } from './meter';

const meters = new WeakMap<object, Meter>();


instrument(Product.prototype, 'facet', (receiver) => meters.get(receiver), { internal: ['workspace', 'state', 'open', 'prepared', 'withChat', 'models'] });

export class AgentFacet extends Product {
  private readonly perfMeter: Meter;

  constructor(...args: ConstructorParameters<typeof Product>) {
    super(...args);
    this.perfMeter = new Meter(this.ctx.storage.sql);
    meters.set(this, this.perfMeter);
  }

  async perfBegin(): Promise<void> { this.perfMeter.begin(); }

  async perfJoin(): Promise<void> {
    this.perfMeter.ignoreNextRpc('facet.idle');
    await super.idle();
  }

  async perfCut(label: string, resume: boolean): Promise<Slice> { return this.perfMeter.cut(label, resume); }
}
