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
    protected explorationSeams(): {
      readonly host: {
        acquire(reference: ActorReference): Promise<HostedActor>;
        release(reference: ActorReference): void;
      };
      register(input: { readonly creationId: string; readonly kind: 'head' }): Promise<ActorReference>;
    };
  }

  const handler: ExportedHandler;
  export default handler;
}
