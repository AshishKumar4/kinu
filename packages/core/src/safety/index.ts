/**
 * Safety subsystem — approval gating + (future) sandboxing policies.
 */

export {
  reviewCommand,
  formatApproval,
  withApprovalGate,
  type ApprovalDecision,
  type ApprovalRuleHit,
  type ApprovalResult,
} from './approval-gate.js';
