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
  type ShellApprovalRequest,
  type ShellApprovalOutcome,
  type ShellApprovalPolicy,
  type InheritedApprovalSource,
  type DeferredApprovalChannel,
} from './approval-gate.js';

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
} from './egress-gate.js';

export {
  DeferredApprovalQueue,
  DeferredApprovalStore,
  initDeferredApprovalsTable,
  queuedActionMessage,
  deniedActionMessage,
  decisionWakeMessage,
  DEFERRED_APPROVAL_SIGNAL,
  type DeferredApproval,
  type DeferredApprovalStatus,
  type DeferredApprovalAnswer,
  type DeferredApprovalVerdict,
  type DeferredApprovalNotice,
  type DeferredApprovalQueueDeps,
} from './deferred-approval.js';

export {
  argumentDigest,
  sha256Hex,
  stableStringify,
} from './argument-digest.js';

export {
  DeviceConsentRegistry,
  DEVICE_CONSENT_SCOPE,
  DEVICE_CONSENT_SCOPE_FULL_FS,
  DEVICE_CONSENT_DENIED,
  DEVICE_CONSENT_UNANSWERED,
  DEVICE_CONSENT_TIMEOUT_MS,
  parseConsentScope,
  mergeConsentScope,
  summarizeDeviceAction,
  type DeviceConsentScope,
  type DeviceConsentDecision,
  type DeviceConsentAnswer,
  type DeviceActionSummary,
  type DeviceConsentRequest,
  type PendingDeviceConsent,
  type DeviceConsentNotice,
  type DeviceConsentRegistryDeps,
} from './device-consent.js';
