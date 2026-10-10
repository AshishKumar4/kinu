/** The built bundle's `index.js`, as much of it as `product.ts` reaches; the bundle carries no types. */
declare module 'kinu:product' {
  import { DurableObject } from 'cloudflare:workers';

  interface ActorReference {
    readonly actorId: string;
    readonly workspaceId: string;
    readonly parentActorId: string | null;
  }

  interface HostedActor {
    readonly reference: ActorReference;
  }

  export class OrchestratorAgent extends DurableObject {
    /** Private in the source; the probe reads its size. */
    protected readonly delegatedTurns: { readonly actorRunners: ReadonlyMap<string, Promise<void>> };
    protected hostedSeams(): {
      readonly host: {
        acquire(reference: ActorReference, seat: { readonly kind: 'actor' | 'head' | 'node' }): Promise<HostedActor>;
        release(reference: ActorReference): void;
      };
      register(input: { readonly creationId: string }): Promise<ActorReference>;
    };
    protected get config(): { setSleepTimeComputeEnabled(enabled: boolean): void };
    protected settleBackgroundTasks(): Promise<void>;
    protected get terminal(): { idle(): Promise<void> };
    protected actorHandle(): { readonly actorId: string };
    /** Main's isolate, or another agent's, as the bundle reaches it. */
    protected agentFacetOf<Facet extends Rpc.WorkerEntrypointBranded>(actorId: string): Promise<Fetcher<Facet>>;
  }

  const handler: ExportedHandler;
  export default handler;
}
