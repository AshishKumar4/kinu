import { ContentRef, type WorkspaceId } from '@agent-core/core';
import type { BindingRequirement } from '@agent-core/core/facets';
import type { EnvironmentSessionCapability, PortExposureId } from '@agent-core/core/environment-provider';
import {
  SlateId, SlateVersionId, SlatePublicationId, SlateDeploymentId, SlateResourceId, SlatePreviewId,
  SlateIdSource, SlateMutationSeam, SlateRuntime, SlateSkeleton,
  type Slate, type SlateInstantiation, type SlateMutationRequest, type SlateProvider, type SlateInvocationSeam,
  type SlatePreviewValidationSeam, type SlatePublication, type SlateStore, type SlateVersion,
} from '@agent-core/core/slates';
import { nanoid } from '../utils/nanoid';
import type { SlateFiles } from './files';
import { KinuError } from '../obs/error';

function requireCapability<Capability>(capability: Capability | undefined, name: string): Capability {
  if (capability === undefined) throw new KinuError('unsupported', 'Slate ' + name + ' capability is not configured');

  return capability;
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
  readonly provider?: SlateProvider;
  /** Owns the outer VFS transaction so record writes and source restoration roll back together. */
  readonly mutations: SlateMutationSeam;
  readonly invocations?: SlateInvocationSeam;
  readonly previewValidation?: SlatePreviewValidationSeam;
}

export class WorkspaceSlates {
  constructor(private readonly deps: WorkspaceSlatesDeps) {}

  // The vendored runtime requires each seam. Capabilities arrive independently;
  // an absent effect capability refuses only when that operation is attempted.
  private readonly provider: SlateProvider = {
    deploy: (request) => requireCapability(this.deps.provider, 'deployment').deploy(request),
    reconcileDeployment: (request) => requireCapability(this.deps.provider, 'deployment').reconcileDeployment(request),
    materializeResource: (request) => requireCapability(this.deps.provider, 'resource provisioning').materializeResource(request),
    reconcileResource: (request) => requireCapability(this.deps.provider, 'resource provisioning').reconcileResource(request),
  };
  private readonly invocations: SlateInvocationSeam = {
    prepare: (request) => requireCapability(this.deps.invocations, 'external invocation').prepare(request),
    invoke: (request, id, effect) => requireCapability(this.deps.invocations, 'external invocation').invoke(request, id, effect),
    reconcile: (request, id, effect) => requireCapability(this.deps.invocations, 'external invocation').reconcile(request, id, effect),
  };
  private readonly previewValidation: SlatePreviewValidationSeam = {
    validate: (request) => requireCapability(this.deps.previewValidation, 'durable preview validation').validate(request),
  };

  async synchronize(id: SlateId): Promise<Slate> {
    const source = this.deps.files.transaction(() => this.deps.files.capture(id));
    const current = this.deps.store.getSlate(id);

    if (current === undefined) return this.runtime(id).create(this.deps.workspaceId, source);

    if (!current.workspaceId.equals(this.deps.workspaceId)) throw new KinuError('denied', 'Slate belongs to another workspace');

    if (current.source.equals(source)) return current;

    return this.runtime().update(id, source, current.revision);
  }

  async commit(id: SlateId) {
    const slate = await this.synchronize(id);

    return this.runtime().commit(id, slate.revision);
  }

  fork(versionId: SlateVersionId) {
    return this.runtime().fork(versionId, this.deps.workspaceId);
  }

  async restore(id: SlateId, versionId: SlateVersionId): Promise<Slate> {
    const version = this.deps.store.getVersion(versionId);

    if (version === undefined || !version.slateId.equals(id) || !version.workspaceId.equals(this.deps.workspaceId)) {
      throw new KinuError('missing', 'Source restoration requires a version of this Slate');
    }

    const current = await this.synchronize(id);

    if (current.source.equals(version.source)) return current;

    return this.runtime(undefined, true).update(id, version.source, current.revision);
  }

  /** `materialization` is the whole version source by default, or the owner's included subset. */
  publish(versionId: SlateVersionId, bindings: readonly BindingRequirement[], materialization?: ContentRef): Promise<SlatePublication> {
    const version = this.version(versionId);

    return this.runtime().publish(versionId, materialization ?? version.source, bindings);
  }

  publication(publicationId: SlatePublicationId): SlatePublication {
    return this.owned(this.deps.store.getPublication(publicationId), 'Slate publication not found');
  }

  /** Credential-free: when a subset was published, the skeleton names the materialization, not the version source. */
  skeleton(publicationId: SlatePublicationId): SlateSkeleton {
    const publication = this.publication(publicationId);
    const version = this.version(publication.versionId);

    if (publication.materialization.equals(version.source)) return this.runtime().exportSkeleton(publicationId);

    return new SlateSkeleton(publication.materialization.digest, publication.bindings);
  }

  /** Admit a skeleton as a new slate of this workspace. Every requirement comes back unsatisfied; nothing runs. */
  instantiate(skeleton: SlateSkeleton, source: ContentRef): Promise<SlateInstantiation> {
    return this.runtime().instantiate(skeleton, this.deps.workspaceId, source);
  }

  deploy(publicationId: SlatePublicationId, externalKey: string) {
    return this.runtime().deploy(publicationId, 'kinu', externalKey);
  }

  rollback(id: SlateId, deploymentId: SlateDeploymentId, expectedActiveDeploymentId: SlateDeploymentId) {
    return this.runtime().rollback(id, deploymentId, expectedActiveDeploymentId);
  }

  linkPreview(id: SlateId, capability: EnvironmentSessionCapability, exposureId: PortExposureId, versionId?: SlateVersionId) {
    return this.runtime().linkPreview(id, capability, exposureId, versionId);
  }

  source(versionId: SlateVersionId): ContentRef {
    return this.version(versionId).source;
  }

  version(versionId: SlateVersionId): SlateVersion {
    return this.owned(this.deps.store.getVersion(versionId), 'Slate version not found');
  }

  private owned<T extends { readonly workspaceId: WorkspaceId }>(found: T | undefined, missing: string): T {
    if (found === undefined || !found.workspaceId.equals(this.deps.workspaceId)) throw new KinuError('missing', missing);

    return found;
  }

  private runtime(authoredId?: SlateId, restoring = false): SlateRuntime {
    return new SlateRuntime(
      this.deps.store, this.provider,
      new WorkspaceSlateMutation(this.deps.mutations, this.deps.files, restoring),
      this.invocations, this.previewValidation, new WorkspaceSlateIds(authoredId),
    );
  }
}
