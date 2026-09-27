import { ContentRef, type WorkspaceId } from '@agent-core/core';
import type { BindingRequirement } from '@agent-core/core/facets';
import {
  SlateId, SlateVersionId, SlatePublicationId, SlateDeploymentId, SlateResourceId, SlatePreviewId,
  SlateIdSource, SlateMutationSeam, SlateRuntime, SlateSkeleton,
  type Slate, type SlateInstantiation, type SlateMutationRequest, type SlateProvider, type SlateInvocationSeam,
  type SlatePreviewValidationSeam, type SlatePublication, type SlateStore, type SlateVersion,
} from '@agent-core/core/slates';
import { nanoid } from '../utils/nanoid';
import type { SlateFiles } from './files';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settle, settleSync } from '../obs/effect';

function unsupported(name: string): KinuError {
  return new KinuError('unsupported', 'Slate ' + name + ' is not supported');
}

class WorkspaceSlateIds extends SlateIdSource {
  constructor(private readonly authoredId?: SlateId) { super(); }
  allocateSlateId(): SlateId { return this.authoredId ?? new SlateId(nanoid()); }
  allocateVersionId(): SlateVersionId { return new SlateVersionId(nanoid()); }
  allocatePublicationId(): SlatePublicationId { return new SlatePublicationId(nanoid()); }
  allocateDeploymentId(): SlateDeploymentId { return new SlateDeploymentId(nanoid()); }
  allocateResourceId(): SlateResourceId { return new SlateResourceId(nanoid()); }
  allocatePreviewId(): SlatePreviewId { return new SlatePreviewId(nanoid()); }
}

class WorkspaceSlateMutation extends SlateMutationSeam {
  constructor(
    private readonly authority: SlateMutationSeam,
    private readonly files: SlateFiles,
    private readonly restoring: boolean,
  ) { super(); }

  mutate<Result>(request: SlateMutationRequest, mutation: () => Result): Promise<Result> {
    return this.authority.mutate(request, () => {
      const result = mutation();

      // Record and tree land in one transaction; the process is never started.
      if (request.operation === 'fork' || request.operation === 'instantiate' || this.restoring && request.operation === 'update') {
        this.files.restore(request.slateId, request.source);
      }

      return result;
    });
  }
}

export interface WorkspaceSlatesDeps {
  readonly workspaceId: WorkspaceId;
  readonly store: SlateStore;
  readonly files: SlateFiles;
  /** Owns the outer VFS transaction so record writes and source restoration roll back together. */
  readonly mutations: SlateMutationSeam;
}

export class WorkspaceSlates {
  constructor(private readonly deps: WorkspaceSlatesDeps) {}

  readonly provider: SlateProvider = {
    deploy: () => settleSync(Effect.fail(unsupported('deployment'))),
    reconcileDeployment: () => settleSync(Effect.fail(unsupported('deployment'))),
    materializeResource: () => settleSync(Effect.fail(unsupported('resource provisioning'))),
    reconcileResource: () => settleSync(Effect.fail(unsupported('resource provisioning'))),
  };
  readonly invocations: SlateInvocationSeam = {
    prepare: () => settleSync(Effect.fail(unsupported('external invocation'))),
    invoke: () => settleSync(Effect.fail(unsupported('external invocation'))),
    reconcile: () => settleSync(Effect.fail(unsupported('external invocation'))),
  };
  readonly previewValidation: SlatePreviewValidationSeam = {
    validate: () => settleSync(Effect.fail(unsupported('preview linking'))),
  };

  async synchronize(id: SlateId): Promise<Slate> {
    return settle(this.synchronized(id));
  }

  private synchronized(id: SlateId): Effect.Effect<Slate, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const source = this.deps.files.transaction(() => this.deps.files.capture(id));
      const current = this.deps.store.getSlate(id);

      if (current === undefined) return yield* Effect.promise(() => this.runtime(id).create(this.deps.workspaceId, source));

      if (!current.workspaceId.equals(this.deps.workspaceId)) return yield* new KinuError('denied', 'Slate belongs to another workspace');

      if (current.source.equals(source)) return current;

      return yield* Effect.promise(() => this.runtime().update(id, source, current.revision));
    });
  }

  async commit(id: SlateId) {
    const slate = await this.synchronize(id);

    return this.runtime().commit(id, slate.revision);
  }

  fork(versionId: SlateVersionId) {
    return this.runtime().fork(versionId, this.deps.workspaceId);
  }

  async restore(id: SlateId, versionId: SlateVersionId): Promise<Slate> {
    return settle(Effect.gen({ self: this }, function* () {
      const version = this.deps.store.getVersion(versionId);

      if (version === undefined || !version.slateId.equals(id) || !version.workspaceId.equals(this.deps.workspaceId)) {
        return yield* new KinuError('missing', 'Source restoration requires a version of this Slate');
      }

      const current = yield* this.synchronized(id);

      if (current.source.equals(version.source)) return current;

      return yield* Effect.promise(() => this.runtime(undefined, true).update(id, version.source, current.revision));
    }));
  }

  /** `materialization` is the whole version source by default, or the owner's included subset. */
  publish(versionId: SlateVersionId, bindings: readonly BindingRequirement[], materialization?: ContentRef): Promise<SlatePublication> {
    const version = this.version(versionId);

    return this.runtime().publish(versionId, materialization ?? version.source, bindings);
  }

  publication(publicationId: SlatePublicationId): SlatePublication {
    return settleSync(this.owned(this.deps.store.getPublication(publicationId), 'Slate publication not found'));
  }

  /** Credential-free: when a subset was published, the skeleton names the materialization, not the version source. */
  skeleton(publicationId: SlatePublicationId): SlateSkeleton {
    const publication = this.publication(publicationId);
    const version = this.version(publication.versionId);

    if (publication.materialization.equals(version.source)) return this.runtime().exportSkeleton(publicationId);

    return new SlateSkeleton(publication.materialization.digest, publication.bindings);
  }

  /** Admit a skeleton as a new slate of this workspace: every requirement comes back unsatisfied, nothing runs. */
  instantiate(skeleton: SlateSkeleton, source: ContentRef): Promise<SlateInstantiation> {
    return this.runtime().instantiate(skeleton, this.deps.workspaceId, source);
  }

  source(versionId: SlateVersionId): ContentRef {
    return this.version(versionId).source;
  }

  version(versionId: SlateVersionId): SlateVersion {
    return settleSync(this.owned(this.deps.store.getVersion(versionId), 'Slate version not found'));
  }

  private owned<T extends { readonly workspaceId: WorkspaceId }>(found: T | undefined, missing: string): Effect.Effect<T, KinuError> {
    return found === undefined || !found.workspaceId.equals(this.deps.workspaceId)
      ? Effect.fail(new KinuError('missing', missing))
      : Effect.succeed(found);
  }

  private runtime(authoredId?: SlateId, restoring = false): SlateRuntime {
    return new SlateRuntime(
      this.deps.store, this.provider,
      new WorkspaceSlateMutation(this.deps.mutations, this.deps.files, restoring),
      this.invocations, this.previewValidation, new WorkspaceSlateIds(authoredId),
    );
  }
}
