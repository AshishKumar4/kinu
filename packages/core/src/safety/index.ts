/**
 * Safety subsystem — approval gating + (future) sandboxing policies.
 */

export {
  reviewCommand,
  formatApproval,
  withApprovalGate,
  approvalGrants,
  type ApprovalDecision,
  type ApprovalRuleHit,
  type ApprovalResult,
  type ShellApprovalRequest,
  type ShellApprovalOutcome,
} from './approval-gate.js';

export {
  argumentDigest,
  sha256Hex,
  stableStringify,
} from './argument-digest.js';
