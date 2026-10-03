import * as v from 'valibot';
import type { JsonValue } from '../utils/json';
import type { BackgroundJobRunner, JobRetirement } from './runner';
import type { BackgroundJob, BackgroundJobStore } from './store';

export type JobAuthorityKind = 'root' | 'hire' | 'step-loop';

export interface JobAuthority {
  readonly kind: JobAuthorityKind;
  readonly actorId: string;
  readonly store: BackgroundJobStore;
  readonly runner: BackgroundJobRunner;
}

export interface WorkspaceJobAuthoritiesDeps {
  readonly root: () => JobAuthority;
  readonly revive: (actorId: string) => JobAuthority | null;
}

const NamedJobSchema = v.object({ jobId: v.string() });

export class WorkspaceJobAuthorities {
  private readonly held = new Map<string, JobAuthority>();

  constructor(private readonly deps: WorkspaceJobAuthoritiesDeps) {}

  root(): JobAuthority {
    return this.deps.root();
  }

  attach(authority: JobAuthority): () => void {
    this.held.set(authority.actorId, authority);

    return () => {
      if (this.held.get(authority.actorId) === authority) this.held.delete(authority.actorId);
    };
  }

  live(actorId: string): JobAuthority | null {
    const root = this.deps.root();

    return actorId === root.actorId ? root : this.held.get(actorId) ?? null;
  }

  of(actorId: string): JobAuthority | null {
    const root = this.deps.root();

    if (actorId === root.actorId) return root;
    const held = this.held.get(actorId);

    if (held !== undefined) return held;
    const revived = this.deps.revive(actorId);

    if (revived !== null) this.held.set(actorId, revived);

    return revived;
  }

  owning(jobId: string): JobAuthority | null {
    const owner = this.deps.root().store.ownerInWorkspace(jobId);

    return owner === null ? null : this.of(owner);
  }

  async recover(checkpoint: JsonValue): Promise<BackgroundJob | null> {
    const named = v.safeParse(NamedJobSchema, checkpoint);
    const authority = (named.success ? this.owning(named.output.jobId) : null) ?? this.deps.root();

    return await authority.runner.recover(checkpoint);
  }

  async recoverOrphans(): Promise<BackgroundJob[]> {
    const root = this.deps.root();
    const recovered = [...await root.runner.recoverOrphans()];

    for (const owner of root.store.runningOwnersInWorkspace()) {
      if (owner === root.actorId) continue;
      const authority = this.of(owner);

      if (authority !== null) recovered.push(...await authority.runner.recoverOrphans());
    }

    return recovered;
  }

  async retire(actorId: string): Promise<JobRetirement> {
    const authority = this.of(actorId);

    if (authority === null) return { stopped: [], refused: [] };
    const retirement = await authority.runner.retire();

    if (retirement.refused.length === 0) this.held.delete(actorId);

    return retirement;
  }
}
