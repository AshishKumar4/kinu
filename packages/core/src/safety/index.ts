/**
 * Safety subsystem — approval gating, device consent, and argument digests.
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
