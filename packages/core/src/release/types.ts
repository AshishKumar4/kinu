export const RELEASE_STATUSES = [
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

export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export type ReleaseSourceKind = 'local' | 'github';

export interface ReleaseSource {
  id: string;
  kind: ReleaseSourceKind;
  label: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  localDeviceId: string | null;
  localRoot: string | null;
  deployTarget: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReleaseChange {
  id: string;
  agentName: string;
  bindingId: string;
  status: ReleaseStatus;
  userPrompt: string;
  plan: string | null;
  summary: string | null;
  patch: string | null;
  previewUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReleaseCheck {
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

export interface ReleaseApproval {
  id: string;
  changeId: string;
  approvalType: 'apply' | 'deploy_staging' | 'deploy_production' | 'rollback';
  decision: 'pending' | 'approved' | 'rejected';
  approvedBy: string | null;
  note: string | null;
  /** SHA-256 binding the reviewable deploy identity (patch + declared command)
   *  this approval authorizes — verified at deploy time (SPEC §7.3). */
  argumentDigest: string;
  createdAt: number;
  decidedAt: number | null;
}

export interface ReleaseDeployment {
  id: string;
  changeId: string;
  environment: 'local' | 'staging' | 'production';
  workerVersionId: string | null;
  deploymentId: string | null;
  rollbackTarget: string | null;
  deployedAt: number;
}

/** Full ledger view of one change — what the execution engine reads. */
export interface ReleaseDetail {
  change: ReleaseChange;
  binding: ReleaseSource | null;
  checks: ReleaseCheck[];
  approvals: ReleaseApproval[];
  deployments: ReleaseDeployment[];
}

export type ReleaseTransitionResult =
  | { ok: true; from: ReleaseStatus; to: ReleaseStatus }
  | { ok: false; from: ReleaseStatus; to: ReleaseStatus; error: string };
