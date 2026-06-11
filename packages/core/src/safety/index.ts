/**
 * Safety subsystem — approval gating + OS sandbox policies.
 * The two compose: the sandbox bounds what's POSSIBLE, the gate decides
 * what's ASKED, and blocked operations surface as structured escalations.
 */

export {
  reviewCommand,
  formatApproval,
  withApprovalGate,
  type ApprovalDecision,
  type ApprovalRuleHit,
  type ApprovalResult,
} from './approval-gate.js';

export {
  SANDBOX_MODES,
  isSandboxMode,
  clampSandboxMode,
  resolveSandboxPolicy,
  isPathWritable,
  normalizePosixPath,
  escalationForWrite,
  detectSandboxDenial,
  formatSandboxEscalation,
  parseSandboxEnforcementReport,
  type SandboxMode,
  type SandboxPolicy,
  type ResolveSandboxPolicyOpts,
  type SandboxEscalation,
  type SandboxEnforcement,
  type SandboxEnforcementReport,
} from './sandbox-policy.js';

export {
  buildSandboxedSpawn,
  buildSeatbeltProfile,
  type SandboxBackend,
  type SandboxLaunch,
  type SandboxSpawnOpts,
} from './sandbox-spawn.js';
