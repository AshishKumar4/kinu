export const PRODUCT_CHANGE_STATUSES = [
  'draft',
  'planning',
  'patching',
  'validating',
  'preview_ready',
  'awaiting_approval',
  'applying',
  'deployed',
  'rejected',
  'rolled_back',
  'failed',
] as const;

export type ProductChangeStatus = (typeof PRODUCT_CHANGE_STATUSES)[number];

export type ProductSourceKind = 'local' | 'github';

export interface ProductSourceBinding {
  id: string;
  kind: ProductSourceKind;
  label: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  localDeviceId: string | null;
  localRoot: string | null;
  deployTarget: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProductChangeRequest {
  id: string;
  agentName: string;
  bindingId: string;
  status: ProductChangeStatus;
  userPrompt: string;
  plan: string | null;
  summary: string | null;
  patch: string | null;
  previewUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProductChangeCheck {
  id: string;
  changeId: string;
  name: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  stdout: string | null;
  stderr: string | null;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProductChangeApproval {
  id: string;
  changeId: string;
  approvalType: 'apply' | 'deploy_staging' | 'deploy_production' | 'rollback';
  decision: 'pending' | 'approved' | 'rejected';
  approvedBy: string | null;
  note: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface ProductDeploymentRecord {
  id: string;
  changeId: string;
  environment: 'local' | 'staging' | 'production';
  workerVersionId: string | null;
  deploymentId: string | null;
  rollbackTarget: string | null;
  deployedAt: number;
}

/** Full ledger view of one change — what the execution engine reads. */
export interface ProductChangeDetail {
  change: ProductChangeRequest;
  binding: ProductSourceBinding | null;
  checks: ProductChangeCheck[];
  approvals: ProductChangeApproval[];
  deployments: ProductDeploymentRecord[];
}

export type ProductChangeTransitionResult =
  | { ok: true; from: ProductChangeStatus; to: ProductChangeStatus }
  | { ok: false; from: ProductChangeStatus; to: ProductChangeStatus; error: string };
