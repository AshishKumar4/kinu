/**
 * SandboxPolicy — the OS-sandbox policy model for local execution.
 *
 * Three modes, modeled on Codex's taxonomy:
 *   • 'read-only'       — no filesystem writes anywhere, no network.
 *   • 'workspace-write' — writes only inside explicit writable roots
 *                         (workspace + tmp by default); network OFF unless
 *                         explicitly enabled.
 *   • 'full'            — no OS restrictions (danger-full-access).
 *
 * The policy says what is POSSIBLE; the approval gate (approval-gate.ts) says
 * what is ASKED. They compose: the gate reviews a command before it runs, the
 * sandbox enforces the boundary while it runs, and a blocked operation comes
 * back as a structured SandboxEscalation — never a silent failure — which an
 * approval surface can turn into a user prompt.
 *
 * Per-invocation overrides are DOWNWARD only (clampSandboxMode): a caller can
 * request a stricter mode than the granted one, never a looser one. Only the
 * user/operator raises the granted mode (config store / device config).
 *
 * This module is platform-pure (no node imports) so it loads on Workers; the
 * OS argv construction lives in sandbox-spawn.ts and the probing/spawning in
 * the backends (cli-backend, pc-agent daemon).
 */

export type SandboxMode = 'read-only' | 'workspace-write' | 'full';

export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'full'];

const MODE_RANK: Record<SandboxMode, number> = { 'read-only': 0, 'workspace-write': 1, full: 2 };

export function isSandboxMode(value: unknown): value is SandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'full';
}

/**
 * Downward-only mode override: the result is never looser than `granted`.
 * Invalid/absent requests keep the granted mode.
 */
export function clampSandboxMode(granted: SandboxMode, requested?: unknown): SandboxMode {
  if (!isSandboxMode(requested)) return granted;
  return MODE_RANK[requested] < MODE_RANK[granted] ? requested : granted;
}

export interface SandboxPolicy {
  readonly mode: SandboxMode;
  /** Absolute roots writable under 'workspace-write'. Empty for the other
   *  modes ('read-only' writes nowhere, 'full' writes everywhere). */
  readonly writableRoots: readonly string[];
  /** Outbound network. Always false in 'read-only', always true in 'full'. */
  readonly network: boolean;
}

export interface ResolveSandboxPolicyOpts {
  mode: SandboxMode;
  /** The workspace the agent operates in (process cwd for the CLI; $HOME for
   *  the device daemon). Writable by default under 'workspace-write'. */
  workspaceRoot: string;
  /** OS temp dir — writable scratch by default under 'workspace-write'. */
  tmpDir?: string;
  /** Operator-granted additional writable roots (absolute paths). */
  extraWritableRoots?: readonly string[];
  /** Outbound network for 'workspace-write' (default OFF). Ignored for
   *  'read-only' (always off) and 'full' (always on). */
  network?: boolean;
}

export function resolveSandboxPolicy(opts: ResolveSandboxPolicyOpts): SandboxPolicy {
  if (opts.mode === 'full') return { mode: 'full', writableRoots: [], network: true };
  if (opts.mode === 'read-only') return { mode: 'read-only', writableRoots: [], network: false };
  const roots = [opts.workspaceRoot, opts.tmpDir, ...(opts.extraWritableRoots ?? [])]
    .filter((r): r is string => typeof r === 'string' && r.length > 0)
    .map(normalizePosixPath);
  return {
    mode: 'workspace-write',
    writableRoots: [...new Set(roots)],
    network: opts.network ?? false,
  };
}

/**
 * Whether the policy permits writing at `path` (absolute). Used to gate
 * direct in-process file writes (laptop.writeFile, the daemon's writeFile)
 * with the same policy the OS enforces on spawned commands. Relative paths
 * never match a root — fail closed.
 */
export function isPathWritable(policy: SandboxPolicy, path: string): boolean {
  if (policy.mode === 'full') return true;
  if (policy.mode === 'read-only') return false;
  const p = normalizePosixPath(path);
  return policy.writableRoots.some((root) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`));
}

/** Collapse `//`, `.` and `..` segments of a POSIX path. Pure (no node:path)
 *  so it runs on Workers. Relative paths are returned normalized-but-relative. */
export function normalizePosixPath(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

// ── Escalation ──────────────────────────────────────────────────────────────

/**
 * A structured "needs escalation" result for an operation the sandbox
 * blocked. Surfaces to the LLM/user with the active mode, what was blocked,
 * and how the operator can grant it — never a silent failure.
 */
export interface SandboxEscalation {
  readonly kind: 'sandbox_escalation';
  readonly mode: SandboxMode;
  readonly blocked: 'filesystem' | 'network';
  /** Evidence: the matched stderr line or the denied path. */
  readonly detail: string;
  /** How the user/operator can grant the capability. */
  readonly remedy: string;
}

export function escalationForWrite(policy: SandboxPolicy, path: string): SandboxEscalation {
  return {
    kind: 'sandbox_escalation',
    mode: policy.mode,
    blocked: 'filesystem',
    detail: policy.mode === 'read-only'
      ? `write to ${path} blocked: mode 'read-only' permits no writes`
      : `write to ${path} blocked: outside writable roots [${policy.writableRoots.join(', ')}]`,
    remedy: fsRemedy(policy.mode),
  };
}

function fsRemedy(mode: SandboxMode): string {
  return mode === 'read-only'
    ? "ask the user/operator to raise the sandbox mode (setSandboxMode 'workspace-write' or 'full'), then retry"
    : "ask the user/operator to add the path to the sandbox writable roots or grant mode 'full' (setSandboxMode), then retry";
}
const NET_REMEDY =
  "network is disabled in this sandbox mode; ask the user/operator to enable sandbox network access or grant mode 'full', then retry";

/** stderr signatures of a sandbox-enforced filesystem denial (bwrap ro-binds
 *  surface as EROFS; Seatbelt as EPERM "Operation not permitted" is too broad
 *  to match — Seatbelt detection relies on EROFS-style messages only). */
const FS_DENIAL = [/read-only file system/i, /\bEROFS\b/];
/** stderr signatures consistent with a no-network namespace. These can also
 *  occur for genuinely-down servers, so the escalation says "likely". */
const NET_DENIAL = [
  /network is unreachable/i,
  /\bENETUNREACH\b/,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /\bEAI_AGAIN\b/i,
  /getaddrinfo/i,
  /failed to connect to .+ port \d+/i,
  /\bECONNREFUSED\b/,
];

/** What the chosen OS backend actually enforces for a given launch. */
export interface SandboxEnforcement {
  /** Filesystem restrictions of the policy are OS-enforced. */
  readonly filesystem: boolean;
  /** The policy's network-off restriction is OS-enforced. */
  readonly network: boolean;
}

/**
 * Post-execution denial detection: map a failed command's stderr back to the
 * sandbox restriction that (likely) caused it. Only checks dimensions the
 * launch actually enforced, so unsandboxed failures never masquerade as
 * sandbox denials.
 */
export function detectSandboxDenial(
  policy: SandboxPolicy,
  result: { exitCode: number; stderr: string },
  enforced: SandboxEnforcement,
): SandboxEscalation | null {
  if (result.exitCode === 0) return null;
  if (enforced.filesystem && policy.mode !== 'full') {
    const line = matchLine(result.stderr, FS_DENIAL);
    if (line) {
      return { kind: 'sandbox_escalation', mode: policy.mode, blocked: 'filesystem', detail: line, remedy: fsRemedy(policy.mode) };
    }
  }
  if (enforced.network && !policy.network) {
    const line = matchLine(result.stderr, NET_DENIAL);
    if (line) {
      return {
        kind: 'sandbox_escalation',
        mode: policy.mode,
        blocked: 'network',
        detail: `likely caused by the sandbox (network disabled): ${line}`,
        remedy: NET_REMEDY,
      };
    }
  }
  return null;
}

function matchLine(stderr: string, patterns: readonly RegExp[]): string | null {
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && patterns.some((p) => p.test(trimmed))) return trimmed.slice(0, 300);
  }
  return null;
}

/**
 * Render an escalation for tool output / approval prompts: a human-readable
 * line plus a machine-parsable JSON line (UIs and the approval layer key on
 * `"kind":"sandbox_escalation"`).
 */
export function formatSandboxEscalation(esc: SandboxEscalation): string {
  return (
    `Sandbox blocked this operation (mode=${esc.mode}, blocked=${esc.blocked}). ${esc.detail}. ` +
    `This is the OS sandbox, not a command bug. To proceed: ${esc.remedy}.\n` +
    JSON.stringify(esc)
  );
}

// ── Device wire shape ────────────────────────────────────────────────────────

/**
 * What a device daemon reports about its active sandbox in the HELLO frame —
 * stored by the user-level device hub so consent/status surfaces can show the
 * mode and real enforcement level of the machine they are approving.
 */
export interface SandboxEnforcementReport {
  readonly mode: SandboxMode;
  readonly writableRoots: readonly string[];
  readonly network: boolean;
  /** Which OS mechanism the daemon enforces with ('bwrap', 'sandbox-exec',
   *  'unshare', or 'none'). */
  readonly backend: string;
  readonly enforced: SandboxEnforcement;
}

export function parseSandboxEnforcementReport(value: unknown): SandboxEnforcementReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isSandboxMode(v.mode) || typeof v.backend !== 'string') return null;
  const enforced = (typeof v.enforced === 'object' && v.enforced !== null ? v.enforced : {}) as Record<string, unknown>;
  return {
    mode: v.mode,
    writableRoots: Array.isArray(v.writableRoots) ? v.writableRoots.filter((r): r is string => typeof r === 'string') : [],
    network: v.network === true,
    backend: v.backend,
    enforced: { filesystem: enforced.filesystem === true, network: enforced.network === true },
  };
}
