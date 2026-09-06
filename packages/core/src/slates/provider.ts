import type { ContentRef } from '@agent-core/core';
import {
  SlateProvider, type SlateProviderDeployment, type SlateProviderDeploymentRequest,
  type SlateProviderResource, type SlateProviderResourceRequest,
} from '@agent-core/core/slates';
import { KinuError } from '../obs/error';

export class KinuSlateProvider extends SlateProvider {
  constructor(private readonly ensureDeployment: (request: SlateProviderDeploymentRequest) => Promise<ContentRef>) {
    super();
  }

  async deploy(request: SlateProviderDeploymentRequest): Promise<SlateProviderDeployment> {
    if (request.target !== 'kinu') throw new KinuError('unsupported', 'External Slate deployment is not supported. Stage 0 serves committed versions on the Kinu preview rail.');
    return { materialization: await this.ensureDeployment(request) };
  }

  reconcileDeployment(request: SlateProviderDeploymentRequest): Promise<SlateProviderDeployment> {
    return this.deploy(request);
  }

  materializeResource(_request: SlateProviderResourceRequest): Promise<SlateProviderResource> {
    return Promise.reject(new KinuError('unsupported', 'Stage 0 Slate deployments use workspace capabilities. External resource provisioning is not supported.'));
  }

  reconcileResource(request: SlateProviderResourceRequest): Promise<SlateProviderResource> {
    return this.materializeResource(request);
  }
}
