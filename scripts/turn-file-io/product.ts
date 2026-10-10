/** Built product, with measurement-only RPCs. The shipped bundle itself is not rewritten. */
import { OrchestratorAgent as Product, AgentWorkspaceRPC as Relay } from 'kinu:product';
import type { AgentFacet as MeasuredFacet } from './facet';
import { Meter, instrument, type Slice, type RpcReceiver } from './meter';
import { JsonObjectSchema } from '@kinu.run/core';
import type { Tool } from 'ai';
import * as v from 'valibot';
import type { ChatSession } from '@kinu.run/core';

export * from 'kinu:product';

export { default } from 'kinu:product';

const meters = new Map<string, Meter>();

const hostMeters = new WeakMap<object, Meter>();

const hostsInstrumented = new WeakSet<object>();

const relayMeters = new WeakMap<RpcReceiver, Meter>();

const FetcherSchema = v.custom<Fetcher>((value) => typeof value === 'object' && value !== null && 'fetch' in value && typeof value.fetch === 'function');

instrument(Relay.prototype, 'relay', (receiver) => relayMeters.get(receiver), ['host', 'owned']);

export class AgentWorkspaceRPC extends Relay {
  constructor(...args: ConstructorParameters<typeof Relay>) {
    super(...args);
    const props = v.parse(v.object({ workspace: v.string() }), args[0].props);
    const meter = meters.get(props.workspace);

    if (meter !== undefined) relayMeters.set(this, meter);
  }
}

export class OrchestratorAgent extends Product {
  private readonly perfMeter: Meter;
  private perfCachedFacet: Fetcher<MeasuredFacet> | undefined;
  protected declare readonly chatLoop: ChatSession | undefined;

  constructor(...args: ConstructorParameters<typeof Product>) {
    super(...args);
    const tail = v.safeParse(v.object({ PERF_TAIL: FetcherSchema }), this.env);

    if (tail.success) {
      const loader = this.env.LOADER;
      const original = loader.get.bind(loader);
      loader.get = (name, load) => original(name, async () => ({ ...await load(), tails: [tail.output.PERF_TAIL] }));
    }

    this.perfMeter = new Meter(this.ctx.storage.sql);
    meters.set(this.ctx.id.toString(), this.perfMeter);

    for (const name of Object.getOwnPropertyNames(OrchestratorAgent.prototype)) {
      if (name.startsWith('perf')) Reflect.deleteProperty(this, name);
    }
  }

  override agentWorkspace(actorId: string) {
    this.perfMeter.rpc('workspace.agentWorkspace');
    const host = super.agentWorkspace(actorId);
    hostMeters.set(host, this.perfMeter);
    const proto: RpcReceiver = Object.getPrototypeOf(host);

    if (!hostsInstrumented.has(proto)) {
      instrument(proto, 'host', (receiver) => hostMeters.get(receiver), ['open']);
      hostsInstrumented.add(proto);
    }

    return host;
  }

  private async perfFacet(): Promise<Fetcher<MeasuredFacet> | null> {
    // Before f2fa713f7 main has no isolate. Its actor directory row is the placement authority.
    if (v.parse(v.object({ PERF_ISOLATED: v.string() }), this.env).PERF_ISOLATED !== '1') return null;

    this.perfCachedFacet ??= await this.agentFacetOf<MeasuredFacet>(this.actorHandle().actorId);

    return this.perfCachedFacet;
  }

  async perfBegin(): Promise<void> {
    await (await this.perfFacet())?.perfBegin();
    this.perfMeter.begin();
  }

  async perfCut(label: string, resume: boolean): Promise<{ workspace: Slice; facet: Slice | null }> {
    const local = this.perfMeter.cut(label, false);
    const facet = await this.perfFacet();
    const cost = await facet?.perfCut(label, false);

    if (resume) {
      await facet?.perfBegin();
      this.perfMeter.begin();
    }

    return { workspace: local, facet: cost ?? null };
  }

  async perfQuiet(): Promise<void> {
    this.config.setSleepTimeComputeEnabled(false);
    await this.perfJoin();
  }

  async perfJoin(): Promise<void> {
    await (await this.perfFacet())?.perfJoin();
    await this.chatLoop?.pumpPromise;
    await this.settleBackgroundTasks();
    await this.terminal.idle();
  }

  async perfWarmFiles(): Promise<void> { this.getRawToolsForWorkMode('build'); }

  async perfSeed(): Promise<void> {
    const root = '/home/main/perfio';
    await this.rt.storage.vfs.mkdir(root, { recursive: true });
    await this.rt.storage.vfs.mkdir(`${root}/many`, { recursive: true });
    const encode = new TextEncoder();

    for (const bytes of [4096, 65536, 1048576]) {
      const line = 'probe needle ' + 'x'.repeat(114) + '\n';
      const content = line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
      await this.rt.storage.vfs.writeFile(`${root}/read-${String(bytes)}.txt`, encode.encode(content));
    }

    for (let at = 0; at < 500; at++) {
      await this.rt.storage.vfs.writeFile(`${root}/many/f${String(at).padStart(3, '0')}.txt`, encode.encode(`probe needle ${String(at)}\n`));
    }

    await this.rt.storage.vfs.writeFile(`${root}/edit.txt`, encode.encode('anchor-a\n' + 'x'.repeat(4087)));
    await this.perfWarmFiles();
  }

  async perfTool(name: string, input: string): Promise<string> {
    this.acc.context.reset();
    const tool = this.getRawToolsForWorkMode('build')[name];

    if (tool?.execute === undefined) throw new Error(`tool ${name} is absent`);
    const callable: Tool = tool;
    const parsed = v.parse(v.pipe(v.string(), v.parseJson(), JsonObjectSchema), input);
    const result: unknown = await callable.execute?.(parsed, { toolCallId: `perf-${crypto.randomUUID()}`, messages: [], context: undefined });

    return typeof result === 'string' ? result : JSON.stringify(result);
  }
}
