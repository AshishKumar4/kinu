/**
 * Safety subsystem — approval gating, deferred approval, device consent, and
 * argument digests.
 */

export {
  reviewCommand,
  formatApproval,
  gatedGrants,
  formatApprovalGrant,
  parseApprovalGrant,
  approvalGrants,
  gateExec,
  decideApproval,
  grantsAreSubset,
  resolveInheritedGrants,
  createInheritedApprovalPolicy,
  STRICT_NO_CHANNEL_POLICY,
  type ApprovalDecision,
  type ApprovalRuleHit,
  type ApprovalResult,
  type ApprovalHarm,
  type ApprovalGrant,
  type ApprovalSpend,
  type ShellApprovalRequest,
  type ShellApprovalOutcome,
  type ShellApprovalPolicy,
  type InheritedApprovalSource,
  type DeferredApprovalChannel,
} from './approval-gate';

export {
  EGRESS_PLACEHOLDER_PREFIX,
  EGRESS_PLACEHOLDER_BYTES,
  EGRESS_EXECUTOR,
  grantedEgressBindings,
  isEgressPlaceholder,
  findEgressPlaceholders,
  egressSecretRule,
  parseEgressSecretRule,
  egressHostMatches,
  reviewEgressBinding,
  egressBindingAction,
  planEgress,
  scrubText,
  createScrubStream,
  type EgressSecretBinding,
  type EgressRequestFacts,
  type EgressSubstitution,
  type EgressPlan,
  type ScrubReplacement,
} from './egress-gate';

export {
  DeferredApprovalQueue,
  DeferredApprovalStore,
  initDeferredApprovalsTable,
  queuedActionMessage,
  deniedActionMessage,
  decisionWakeMessage,
  DEFERRED_APPROVAL_SIGNAL,
  DENIAL_STANDING_MS,
  type DeferredApproval,
  type DeferredApprovalStatus,
  type DeferredApprovalAnswer,
  type DeferredApprovalVerdict,
  type DeferredApprovalNotice,
  type DeferredApprovalQueueDeps,
} from './deferred-approval';

export {
  argumentDigest,
  sha256Hex,
  stableStringify,
} from './argument-digest';

export {
  InstructionApprovalStore,
  initInstructionApprovalsTable,
  instructionDigest,
  trustOfInstructionApprovals,
  admitInstructionDecision,
  type InstructionTrust,
  type InstructionDecision,
  type InstructionApproval,
  type InstructionTrustResolver,
  type VerifiedInstructionTrust,
  type AdmittedInstructionDecision,
} from './instruction-trust';

export {
  DeviceConsentRegistry,
  DEVICE_CONSENT_DENIED,
  DEVICE_CONSENT_UNANSWERED,
  DEVICE_CONSENT_TIMEOUT_MS,
  DEVICE_PROVISION_METHOD,
  DEVICE_CONNECT_DISCLOSURE,
  summarizeDeviceAction,
  type DeviceConsentDecision,
  type DeviceConsentAnswer,
  type DeviceActionSummary,
  type DeviceConsentRequest,
  type PendingDeviceConsent,
  type DeviceConsentNotice,
  type DeviceConsentRegistryDeps,
} from './device-consent';

export {
  refusedHostname,
} from './egress-destination';
export type { Refusal } from '../obs/error';
