// Over a recording ctx.container: the pool runs no containers.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { CodexEgress } from '../../src/egress/codex-egress';
import type { ProbeRecords, StartConfig } from './codex-egress-records';

const RECORDS = new Map<string, { starts: StartConfig[] }>();

function recordsOf(id: string): { starts: StartConfig[] } {
  const found = RECORDS.get(id) ?? { starts: [] };

  RECORDS.set(id, found);

  return found;
}

function recordingContainer(id: string) {
  return {
    running: false,
    start(config: { readonly entrypoint?: readonly string[]; readonly env?: Readonly<Record<string, string>> }): void {
      recordsOf(id).starts.push({ entrypoint: config.entrypoint, env: config.env });
    },
    monitor: async (): Promise<never> => { throw new Error('probe: the container exited'); },
    getTcpPort: () => ({ fetch: async () => { throw new Error('probe: the container never listens'); } }),
    destroy: async () => {},
    signal: () => {},
  };
}

export class CodexEgressProbe extends CodexEgress {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    Object.defineProperty(ctx, 'container', { value: recordingContainer(ctx.id.toString()), configurable: true });
    super(ctx, env);
  }
}

export class Records extends WorkerEntrypoint<Env> {
  read(id: string): ProbeRecords {
    return { starts: [...recordsOf(id).starts] };
  }
}

export default { fetch: (): Response => new Response('codex-egress-probe') };
