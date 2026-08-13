/**
 * Approval gate — Hermes-style dangerous-command detection for shell exec.
 *
 * Pre-execution pass over commands the LLM wants to run in a sandbox.
 * Classifies as:
 *   • 'allow'   — safe; execute immediately
 *   • 'warn'    — unusual but not destructive; log + execute
 *   • 'gate'    — high risk; require user approval via cf_agent_tool_approval
 *   • 'deny'    — never execute (e.g. obvious prompt injection, recursive rm /)
 *
 * Patterns are conservative; the agent can always work around them by
 * splitting commands. False positives degrade slightly (an extra approval
 * prompt) — that's the right tradeoff.
 *
 * Influences come from Hermes's tools/approval.py (battle-tested regex set
 * for sudo / rm -rf / shell-meta escapes / cloud-metadata SSRF). Source
 * patterns ported here aren't a 1:1 copy — that file is 62K — but follow
 * the same intuition + add Cloudflare-Workers-specific deny rules.
 */

export type ApprovalDecision = 'allow' | 'warn' | 'gate' | 'deny';

export interface ApprovalRuleHit {
  readonly decision: ApprovalDecision;
  readonly rule: string;
  readonly explanation: string;
}

export interface ApprovalResult {
  readonly decision: ApprovalDecision;
  /** All rules that fired (highest-severity wins; this lists every match). */
  readonly hits: readonly ApprovalRuleHit[];
}

/** What an interactive approval channel is asked about: the command that hit
 *  the gate and the review explaining why. */
export interface ShellApprovalRequest {
  readonly command: string;
  readonly review: ApprovalResult;
}

/** A channel's answer. 'allow'/'deny' apply to this command only; the
 *  '_always' variants also carry the user's intent to change the session's
 *  standing shell approval mode. */
export type ShellApprovalOutcome = 'allow' | 'allow_always' | 'deny' | 'deny_always';

/** Whether an outcome lets the command run. */
export function approvalGrants(outcome: ShellApprovalOutcome): boolean {
  return outcome === 'allow' || outcome === 'allow_always';
}

interface Rule {
  pattern: RegExp;
  decision: ApprovalDecision;
  name: string;
  why: string;
}

/**
 * Default rule set. Roughly ordered by severity (deny → gate → warn).
 * Adding a rule: prefer specificity over breadth — false-negatives are
 * recoverable (user denies), false-positives are annoying (paper-cut UX).
 */
const RULES: Rule[] = [
  // ── DENY: obviously destructive or filesystem-corrupting ─────────
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*(?:$|\s)/,
    decision: 'deny',
    name: 'rm-rf-root',
    why: 'Deletes the entire root filesystem.',
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    decision: 'deny',
    name: 'fork-bomb',
    why: 'Classic shell fork bomb pattern.',
  },
  {
    pattern: /\bdd\s+if=\/dev\/(zero|urandom)\s+of=\/dev\/sd[a-z]/i,
    decision: 'deny',
    name: 'dd-overwrite-disk',
    why: 'Overwrites raw block devices.',
  },
  {
    pattern: /\bmkfs\.[a-z0-9]+\s+\/dev\/sd[a-z]/i,
    decision: 'deny',
    name: 'mkfs-physical-disk',
    why: 'Reformats a real disk device.',
  },
  {
    pattern: /\b(curl|wget)\s+[^|]*\|\s*sh\b/i,
    decision: 'deny',
    name: 'pipe-to-shell',
    why: 'Downloads remote script and pipes directly to shell.',
  },
  {
    pattern: /\b(curl|wget)\s+[^|]*\|\s*bash\b/i,
    decision: 'deny',
    name: 'pipe-to-bash',
    why: 'Downloads remote script and pipes directly to bash.',
  },

  // ── GATE: privileged or sensitive operations ─────────────────────
  {
    pattern: /(?:^|\s)\bsudo\b/,
    decision: 'gate',
    name: 'sudo',
    why: 'Privilege escalation — requires explicit user approval.',
  },
  {
    pattern: /\bsu\s+-/,
    decision: 'gate',
    name: 'su',
    why: 'User switching — requires explicit user approval.',
  },
  {
    pattern: /\bchmod\s+(?:[ugoa]*\+s|\+s|4\d\d\d?|7\d\d\d?)/,
    decision: 'gate',
    name: 'chmod-setuid',
    why: 'Sets setuid/setgid bits.',
  },
  {
    pattern: /\b(chown|chgrp)\s+(-R\s+)?(root|0)\b/i,
    decision: 'gate',
    name: 'chown-root',
    why: 'Reassigns ownership to root.',
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*r/i,
    decision: 'gate',
    name: 'rm-recursive',
    why: 'Recursive delete.',
  },
  {
    pattern: /\bgit\s+push\s+(?:-f|--force)/,
    decision: 'gate',
    name: 'git-force-push',
    why: 'Force-push rewrites remote history.',
  },
  {
    pattern: /\bgit\s+reset\s+--hard/,
    decision: 'gate',
    name: 'git-reset-hard',
    why: 'Discards local changes irreversibly.',
  },
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b/,
    decision: 'gate',
    name: 'package-publish',
    why: 'Publishes to a public package registry.',
  },
  {
    pattern: /\bdocker\s+(rm\s+-f|system\s+prune)/,
    decision: 'gate',
    name: 'docker-destructive',
    why: 'Docker destructive operation.',
  },

  // ── DENY: prompt-injection / cloud-metadata SSRF ─────────────────
  {
    pattern: /\b169\.254\.169\.254\b/,
    decision: 'deny',
    name: 'cloud-metadata-ip',
    why: 'AWS/GCP/Azure cloud-metadata endpoint — common SSRF target.',
  },
  {
    pattern: /\bmetadata\.google\.internal\b/,
    decision: 'deny',
    name: 'gcp-metadata',
    why: 'GCP metadata endpoint.',
  },

  // ── WARN: secrets exposure pattern ───────────────────────────────
  {
    pattern: /\b(printenv|env)\b(?!\s*\|.*grep)/,
    decision: 'warn',
    name: 'env-dump',
    why: 'Prints environment variables (may leak secrets to LLM output).',
  },
  {
    pattern: /\bcat\s+.*(\.env|\.npmrc|\.pypirc|\.aws|\.ssh|credentials)/i,
    decision: 'warn',
    name: 'secret-file-read',
    why: 'Reads a file likely to contain secrets.',
  },
];

/**
 * Severity rank for picking the dominant decision when multiple rules fire.
 * Higher number = more severe.
 */
const SEVERITY: Record<ApprovalDecision, number> = {
  allow: 0,
  warn: 1,
  gate: 2,
  deny: 3,
};

export function reviewCommand(command: string): ApprovalResult {
  const hits: ApprovalRuleHit[] = [];
  for (const r of RULES) {
    if (r.pattern.test(command)) {
      hits.push({ decision: r.decision, rule: r.name, explanation: r.why });
    }
  }
  if (hits.length === 0) {
    return { decision: 'allow', hits: [] };
  }
  // Pick the highest-severity decision.
  const decision = hits.reduce<ApprovalDecision>(
    (acc, h) => (SEVERITY[h.decision] > SEVERITY[acc] ? h.decision : acc),
    'allow',
  );
  return { decision, hits };
}

/**
 * Format the result as a human-readable message — used in approval prompts
 * and in error strings returned to the LLM on deny.
 */
export function formatApproval(result: ApprovalResult): string {
  if (result.decision === 'allow') return '';
  const lines = result.hits.map((h) => `• ${h.rule} (${h.decision}): ${h.explanation}`);
  return [`Approval review: ${result.decision}`, ...lines].join('\n');
}

/**
 * Convenience: wrap an exec function with approval gating.
 *
 * The wrapped exec, given a command, runs through reviewCommand first:
 *   • 'allow' / 'warn' → exec proceeds (warn logs the hits)
 *   • 'gate' → if `onApprovalRequest` resolves true, exec proceeds; else denied string
 *   • 'deny' → never exec, returns denial string
 */
export function withApprovalGate<R>(
  exec: (cmd: string) => Promise<R>,
  denyResult: (msg: string) => R,
  onApprovalRequest?: (cmd: string, review: ApprovalResult) => Promise<boolean>,
): (cmd: string) => Promise<R> {
  return async (cmd) => {
    const review = reviewCommand(cmd);
    if (review.decision === 'allow') return exec(cmd);
    if (review.decision === 'warn') {
      console.warn(`[approval-gate] warn: ${formatApproval(review)}`);
      return exec(cmd);
    }
    if (review.decision === 'deny') {
      return denyResult(`Denied by approval gate:\n${formatApproval(review)}`);
    }
    // gate
    if (!onApprovalRequest) {
      return denyResult(`Requires approval (no approver wired):\n${formatApproval(review)}`);
    }
    const approved = await onApprovalRequest(cmd, review);
    if (!approved) {
      return denyResult(`Denied by user:\n${formatApproval(review)}`);
    }
    return exec(cmd);
  };
}

/**
 * How the `mode`/`allow_all`/`deny_all` ladder is spelled wherever a policy
 * is threaded — kept a plain union here (not imported from config/store.ts)
 * so this file stays import-free: it is a layergate subject source, and the
 * decomposition proof walks its transitive imports to prove the safety-gate
 * layer never reaches another layer's subject.
 */
export type ShellApprovalMode = 'strict' | 'allow_all' | 'deny_all';

/**
 * The live policy every gated exec boundary consults — read at CALL time,
 * not captured when the boundary was wrapped, so a `setShellApprovalMode`
 * RPC or an ACP channel attach/detach takes effect on the very next command
 * with no toolset rebuild required.
 */
export interface ShellApprovalPolicy {
  /** Current standing mode. A live read (e.g. straight off agent_config). */
  mode(): ShellApprovalMode;
  /** The interactive channel consulted for a 'gate' decision under 'strict'.
   *  Omitted, or resolving null, means nobody is listening — 'strict' falls
   *  through to `deferrals` if one is wired, and otherwise keeps its
   *  explanatory refusal. A live read too: a surface may attach/detach the
   *  channel after the boundary was wrapped. */
  requestApproval?(req: ShellApprovalRequest): Promise<ShellApprovalOutcome | null>;
  /** Where a 'gate' decision goes when nobody answered — parked on the owner
   *  rather than refused on their behalf. See {@link DeferredApprovalChannel}. */
  deferrals?: DeferredApprovalChannel;
}

/** The conservative default every gated boundary falls back to when no
 *  policy is supplied: 'strict', with nobody to ask — 'gate' decisions are
 *  refused with the explanatory message, never silently allowed. Matches
 *  what `run` always defaulted to before this policy existed. */
export const STRICT_NO_CHANNEL_POLICY: ShellApprovalPolicy = { mode: () => 'strict' };

/**
 * What the gate does with a 'gate' decision nobody is around to answer:
 * park it on the owner instead of refusing on their behalf.
 *
 * The whole vocabulary of parking — ids, durable rows, the words the model
 * reads, the wake when the owner decides — belongs to
 * safety/deferred-approval.ts. What crosses into THIS file is one verb with
 * two answers, because this file is a layergate subject source and stays
 * import-free (see {@link ShellApprovalMode}); a `DeferredApproval` type here
 * would drag the queue's whole import closure into the safety-gate layer.
 *
 * `run: true` is the only answer that lets the command through, and by the
 * time it is returned the owner's grant is already spent — so one approval
 * can never authorise two executions.
 */
export interface DeferredApprovalChannel {
  park(req: ShellApprovalRequest): { readonly run: true } | { readonly run: false; readonly message: string };
}

/**
 * Wrap ANY exec-shaped function — a `Shell.exec`, an `ExecutorProvider`
 * tool's `execute` — with the FULL mode-aware approval gate. This is the one
 * implementation of "should this command run" used at every boundary a
 * command actually reaches a shell: `run`'s workspace/router dispatch and
 * every ExecutorProvider's `exec`/`startProcess` (see execution/approval.ts),
 * so `run { command }` and the same command reached through codemode
 * (`workspace.exec`, `nimbus.exec`, `sandbox.exec`, `laptop.exec`) answer to
 * the identical decision instead of one tool remembering to ask and the rest
 * not.
 *
 * `denyResult` shapes a gate/deny message into the wrapped function's own
 * return type — a bare string for a codemode tool, `{stdout,stderr,exitCode}`
 * for a raw `Shell`.
 */
export function gateExec<R>(
  execute: (command: string, ...rest: unknown[]) => Promise<R>,
  denyResult: (message: string) => R,
  policy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY,
): (...args: unknown[]) => Promise<R> {
  // A rest-args signature — not `(command: string, ...)` — so the wrapped
  // function stays assignable to `ExecutorProvider['tools'][name].execute`
  // (`(...args: unknown[]) => Promise<unknown>`) as well as to a narrower
  // fixed-shape target like `Shell.exec`.
  return async (...args) => {
    const [command, ...rest] = args;
    const cmd = String(command);
    const mode = policy.mode();
    const review = reviewCommand(cmd);
    if (review.decision === 'deny') {
      return denyResult(`Denied by approval gate:\n${formatApproval(review)}`);
    }
    if (review.decision === 'gate') {
      if (mode === 'allow_all') {
        console.warn(`[approval-gate] gate→allow (allow_all mode): ${formatApproval(review)}`);
      } else {
        // 'deny_all' never asks. Under 'strict' a connected channel gets to
        // put the decision to the user; null means nobody is listening.
        const outcome = mode === 'strict' && policy.requestApproval
          ? await policy.requestApproval({ command: cmd, review })
          : null;
        if (outcome === null) {
          // Nobody decided. Under 'strict' that is an ABSENCE, not a refusal:
          // if a deferral queue is wired, the action is parked on the owner
          // and the model is told exactly that — never that it ran, and never
          // that it was denied. 'deny_all' skips this: the owner's standing
          // answer is already no, so there is nothing to park.
          // The queue is consulted only here, after the interactive channel
          // has declined to decide: when a human IS on the channel their
          // answer is the better one, and replaying a grant they left in the
          // queue hours ago behind their back would be worse.
          const parked = mode === 'strict' ? policy.deferrals?.park({ command: cmd, review }) : undefined;
          if (parked && !parked.run) return denyResult(parked.message);
          if (!parked) {
            return denyResult(
              `Requires user approval (mode=${mode}). Ask the user to approve this command ` +
              `or change the shell approval mode in agent settings.\n${formatApproval(review)}`,
            );
          }
          // parked.run — the owner approved this command while the agent was
          // away and the grant has just been spent; fall through to execute.
        } else if (!approvalGrants(outcome)) {
          return denyResult(`Denied by the user.\n${formatApproval(review)}`);
        }
      }
    }
    if (review.decision === 'warn') {
      if (mode === 'deny_all') {
        return denyResult(`Denied by approval gate (deny_all mode):\n${formatApproval(review)}`);
      }
      console.warn(`[approval-gate] warn: ${formatApproval(review)}`);
    }
    return execute(cmd, ...rest);
  };
}
