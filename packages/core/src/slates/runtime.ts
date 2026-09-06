import { ContentRef, type WorkspaceId } from '@agent-core/core';
import type { BindingRequirement } from '@agent-core/core/facets';
import type { EnvironmentSessionCapability, PortExposureId } from '@agent-core/core/environment-provider';
import {
  SlateId, SlateVersionId, SlatePublicationId, SlateDeploymentId, SlateResourceId, SlatePreviewId,
  SlateIdSource, SlateMutationSeam, SlateRuntime,
  type Slate, type SlateMutationRequest, type SlateProvider, type SlateInvocationSeam,
  type SlatePreviewValidationSeam, type SlateStore,
} from '@agent-core/core/slates';
import { nanoid } from '../utils/nanoid';
import type { SlateFiles } from './files';

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
    private readonly store: SlateStore,
    private readonly files: SlateFiles,
    private readonly restoring: boolean,
  ) { super(); }

  mutate<Result>(request: SlateMutationRequest, mutation: () => Result): Promise<Result> {
    return this.authority.mutate(request, () => this.store.transaction(() => {
      const result = mutation();
      if (request.operation === 'fork' || this.restoring && request.operation === 'update') {
        this.files.restore(request.slateId, request.source);
      }
      return result;
    }));
  }
}

export interface WorkspaceSlatesDeps {
  readonly workspaceId: WorkspaceId;
  readonly store: SlateStore;
  readonly files: SlateFiles;
  readonly provider: SlateProvider;
  readonly mutations: SlateMutationSeam;
  readonly invocations: SlateInvocationSeam;
  readonly previewValidation: SlatePreviewValidationSeam;
}

export class WorkspaceSlates {
  constructor(private readonly deps: WorkspaceSlatesDeps) {}

  async synchronize(id: SlateId): Promise<Slate> {
    const source = this.deps.store.transaction(() => this.deps.files.capture(id));
    const current = this.deps.store.getSlate(id);
    if (current === undefined) return this.runtime(id).create(this.deps.workspaceId, source);
    if (!current.workspaceId.equals(this.deps.workspaceId)) throw new Error('Slate belongs to another workspace');
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
      throw new Error('Source restoration requires a version of this Slate');
    }
    const current = await this.synchronize(id);
    if (current.source.equals(version.source)) return current;
    return this.runtime(undefined, true).update(id, version.source, current.revision);
  }

  publish(versionId: SlateVersionId, bindings: readonly BindingRequirement[]) {
    const version = this.deps.store.getVersion(versionId);
    if (version === undefined || !version.workspaceId.equals(this.deps.workspaceId)) throw new Error('Slate version not found');
    return this.runtime().publish(versionId, version.source, bindings);
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
    const version = this.deps.store.getVersion(versionId);
    if (version === undefined || !version.workspaceId.equals(this.deps.workspaceId)) throw new Error('Slate version not found');
    return version.source;
  }

  private runtime(authoredId?: SlateId, restoring = false): SlateRuntime {
    return new SlateRuntime(
      this.deps.store, this.deps.provider,
      new WorkspaceSlateMutation(this.deps.mutations, this.deps.store, this.deps.files, restoring),
      this.deps.invocations, this.deps.previewValidation, new WorkspaceSlateIds(authoredId),
    );
  }
}
