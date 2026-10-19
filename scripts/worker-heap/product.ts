/**
 * The product worker's entry in `scripts/worker-heap.ts`: the built bundle's own exports, with its workspace class
 * widened by one RPC that hosts exploration heads through the bundle's own actor host, as a swarm does, so the
 * heap after they leave is read on the code the deploy ships.
 */
import { OrchestratorAgent as Product } from 'kinu:product';

export * from 'kinu:product';

export { default } from 'kinu:product';

/** Each buffer the gate plants, under the marker it finds it by: held for the isolate's life, as a leak would be. */
const planted: Record<string, Uint8Array>[] = [];

/** Main's isolate as the gate loads it (`packages/cf-backend/tests/workerd/heap-plant-agent.ts`). */
interface PlantingFacet extends Rpc.WorkerEntrypointBranded {
  plant(marker: string, bytes: number): Promise<void>;
  failedToolCalls(): Promise<number>;
  idle(): Promise<void>;
}

export class OrchestratorAgent extends Product {
  constructor(...args: ConstructorParameters<typeof Product>) {
    super(...args);
    // The product sealed its RPC surface with an own property over every unlisted name; these are the probe's.
    Reflect.deleteProperty(this, 'hostHeads');
    Reflect.deleteProperty(this, 'delegatedRunners');
    Reflect.deleteProperty(this, 'quiesce');
    Reflect.deleteProperty(this, 'joinDetached');
    Reflect.deleteProperty(this, 'plant');
    Reflect.deleteProperty(this, 'failedToolCalls');
    Reflect.deleteProperty(this, 'mainIdle');
    Reflect.deleteProperty(this, 'seedScreenshots');
  }

  /** `count` distinct PNGs of `bytes` at /home/main/shots/step-<i>.png, for the screenshot turn to read: a header naming
   *  1280x800, as a desktop's screenshot does, then filler. */
  async seedScreenshots(count: number, bytes: number): Promise<void> {
    await this.rt.storage.vfs.mkdir('/home/main/shots', { recursive: true });

    for (let at = 0; at < count; at++) {
      const png = new Uint8Array(bytes);

      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 3, 32, 8, 6, 0, 0, 0]);

      for (let index = 29; index < bytes; index++) png[index] = (index * 31 + at * 7919) & 0xff;
      await this.rt.storage.vfs.writeFile(`/home/main/shots/step-${String(at)}.png`, png);
    }
  }

  /** Once main's isolate runs no turn and closes none: its own idle, which the turn it runs ends. */
  async mainIdle(): Promise<void> {
    await (await this.agentFacetOf<PlantingFacet>(this.actorHandle().actorId)).idle();
  }

  /** Main's tool calls that came back failed, as its isolate's ledger records them. */
  async failedToolCalls(): Promise<number> {
    return await (await this.agentFacetOf<PlantingFacet>(this.actorHandle().actorId)).failedToolCalls();
  }

  /** `bytes` held in `isolate` for its life under the property `marker`: the gate finds them there, and only there, to
   *  prove it reads that isolate. */
  async plant(isolate: 'workspace' | 'main', marker: string, bytes: number): Promise<void> {
    if (isolate === 'workspace') planted.push({ [marker]: new Uint8Array(bytes).fill(7) });
    else await (await this.agentFacetOf<PlantingFacet>(this.actorHandle().actorId)).plant(marker, bytes);
  }

  /** What it has detached joined: setting a model tells each agent's isolate, which loads main's (D9). */
  async joinDetached(): Promise<void> {
    await this.settleBackgroundTasks();
  }

  /** Its sleep-time lane off, and what it has detached or still closing joined: a later phase's measurement in this
   *  isolate reads no compression pass of this workspace's in flight. */
  async quiesce(): Promise<void> {
    this.config.setSleepTimeComputeEnabled(false);
    await this.settleBackgroundTasks();
    await this.terminal.idle();
  }

  /** Hired agents still working, as the Agents panel reads them: one rests only after its turn's release has run. */
  async delegatedRunners(): Promise<number> {
    return (await this.listWorkspaceAgents()).filter((agent) => agent.key !== 'main' && agent.activity === 'working').length;
  }

  /** Registers and acquires `count` heads, then releases each: what a swarm's settled nodes leave behind. */
  async hostHeads(tag: string, count: number): Promise<void> {
    const seams = this.hostedSeams();
    const references = [];

    for (let at = 0; at < count; at++) {
      const reference = await seams.register({ creationId: `${tag}-${String(at)}` });
      await seams.host.acquire(reference, { kind: 'node' });
      references.push(reference);
    }

    for (const reference of references) seams.host.release(reference);
  }
}
