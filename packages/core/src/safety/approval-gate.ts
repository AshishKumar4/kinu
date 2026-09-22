/**
 * Approval gate: 'allow' | 'warn' | 'gate' (owner decides) | 'deny' (never, on any executor).
 * A decision depends on rule and executor; binary-scoped rules fire only on invoked binaries, falling back to
 * the whole line under an interpreter. Guardrail against accidents, not an adversary model.
 */

import { CODE_WORK_DID_NOT_START, diagnostics, KinuError, type ErrorCode } from '../obs/index';

export type ApprovalDecision = 'allow' | 'warn' | 'gate' | 'deny';

/** Where a rule's harm lands: 'local' (the executing machine only) or 'reaches_out' (leaves the executor). */
export type ApprovalHarm = 'local' | 'reaches_out';

/** Executors whose local state is the agent's own; local-harm rules are not gated there. Opt-in so new executors fail closed. */
const AGENT_OWN_EXECUTORS: ReadonlySet<string> = new Set(['workspace', 'sandbox']);

export interface ApprovalRuleHit {
  readonly decision: ApprovalDecision;
  readonly rule: string;
  readonly explanation: string;
}

export interface ApprovalResult {
  readonly decision: ApprovalDecision;
  /** Rules that fired, with their decision on this executor. */
  readonly hits: readonly ApprovalRuleHit[];
}

export interface ShellApprovalRequest {
  readonly command: string;
  /** The target executor; the same command is a different request on a different machine. */
  readonly executor: string;
  readonly review: ApprovalResult;
}

/** A channel's answer. 'allow_always' grants each tripped rule on this executor ({@link ApprovalGrant}). */
export type ShellApprovalOutcome = 'allow' | 'allow_always' | 'deny';

export function approvalGrants(outcome: ShellApprovalOutcome): boolean {
  return outcome === 'allow' || outcome === 'allow_always';
}

/** A standing grant: one rule on one executor. */
export interface ApprovalGrant {
  readonly rule: string;
  readonly executor: string;
}

/** Stored spelling of a grant; one token, stored as a comma-separated list. */
export function formatApprovalGrant(grant: ApprovalGrant): string {
  return `${grant.rule}@${grant.executor}`;
}

/** Whether a standing grant covers this rule on this executor. */
export function holdsGrant(grants: readonly ApprovalGrant[], grant: ApprovalGrant): boolean {
  return grants.some((held) => held.rule === grant.rule && held.executor === grant.executor);
}

/** Parse a stored grant; malformed values are not grants. */
export function parseApprovalGrant(raw: string): ApprovalGrant | null {
  const at = raw.indexOf('@');

  if (at <= 0 || at === raw.length - 1) return null;
  const rule = raw.slice(0, at).trim();
  const executor = raw.slice(at + 1).trim();

  return rule && executor ? { rule, executor } : null;
}

interface Rule {
  pattern: RegExp;
  decision: ApprovalDecision;
  name: string;
  why: string;
  harm: ApprovalHarm;
  /** Binaries this rule is about; when present the rule fires only if one is invoked ({@link invokedBinaries}).
   *  Absent: the pattern matches the whole line. Deny rules carry none. */
  binaries?: readonly string[];
}

/** Every ecosystem's publish command. `binaries` gates whether the rule fires, so extend both together. */
const PACKAGE_PUBLISH = new RegExp(
  [
    /\b(?:npm|pnpm|yarn|bun|cargo|poetry|uv|flit|hatch)\s+publish\b/,
    /\btwine\s+upload\b/,
    /\bgem\s+push\b/,
    /\bmvn\s+deploy\b|\bgradlew?\s+[^&|;]*\bpublish[A-Za-z]*/,
    /\bdotnet\s+nuget\s+push\b/,
  ]
    .map((r) => r.source)
    .join('|'),
);

/** Default rule set, resolved per executor by {@link reviewCommand}. `harm: 'local'` claims damage stops at the machine. */
const RULES: Rule[] = [
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*(?:\s+(?:--[^\s]+|-[a-zA-Z]+))*\s+\/+(?=\s|$|[;&|])/,
    decision: 'deny',
    name: 'rm-rf-root',
    why: 'Deletes the entire root filesystem.',
    harm: 'local',
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    decision: 'deny',
    name: 'fork-bomb',
    why: 'Classic shell fork bomb pattern.',
    harm: 'local',
  },
  {
    pattern: /\bdd\b(?=[^;|&\n]*if=\/dev\/(?:zero|urandom)\b)(?=[^;|&\n]*of=\/dev\/(?:sd[a-z]|nvme[^\s;|&]*))/i,
    decision: 'deny',
    name: 'dd-overwrite-disk',
    why: 'Overwrites raw block devices.',
    harm: 'local',
  },
  {
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b[^;|&]*\/dev\/sd[a-z]/i,
    decision: 'deny',
    name: 'mkfs-physical-disk',
    why: 'Reformats a real disk device.',
    harm: 'local',
  },
  {
    pattern: /\b(curl|wget)\s+[^|]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|dash)\b/i,
    decision: 'deny',
    name: 'pipe-to-shell',
    why: 'Downloads remote script and pipes directly to shell.',
    harm: 'reaches_out',
  },
  {
    pattern: /\b(curl|wget)\s+[^|]*\|\s*(?:sudo\s+)?(?:\S*\/)?bash\b/i,
    decision: 'deny',
    name: 'pipe-to-bash',
    why: 'Downloads remote script and pipes directly to bash.',
    harm: 'reaches_out',
  },

  {
    // Just the word: `binaries` decides command position.
    pattern: /\bsudo\b/,
    decision: 'gate',
    name: 'sudo',
    why: 'Privilege escalation on a machine that is not the agent\'s own.',
    harm: 'local',
    binaries: ['sudo'],
  },
  {
    pattern: /\bsu(?:\s+-|\s+\S|\s*$)/,
    decision: 'gate',
    name: 'su',
    why: 'User switching.',
    harm: 'local',
    binaries: ['su'],
  },
  {
    pattern: /\bchmod\s+(?:[ugoa]*\+s|\+s|4\d\d\d?|7\d\d\d?|2\d{3}|3\d{3}|5\d{3}|6\d{3})/,
    decision: 'gate',
    name: 'chmod-setuid',
    why: 'Sets setuid/setgid bits.',
    harm: 'local',
    binaries: ['chmod'],
  },
  {
    pattern: /\b(chown|chgrp)\s+(?:-[^\s]+\s+)*(root|0)\b/i,
    decision: 'gate',
    name: 'chown-root',
    why: 'Reassigns ownership to root.',
    harm: 'local',
    binaries: ['chown', 'chgrp'],
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*r/i,
    decision: 'gate',
    name: 'rm-recursive',
    why: 'Recursive delete.',
    harm: 'local',
    binaries: ['rm'],
  },
  {
    pattern: /\bgit\s+reset\s+--hard/,
    decision: 'gate',
    name: 'git-reset-hard',
    why: 'Discards local changes irreversibly.',
    harm: 'local',
    binaries: ['git'],
  },
  {
    pattern: /\bdocker\s+(rm\s+-f|system\s+prune)/,
    decision: 'gate',
    name: 'docker-destructive',
    why: 'Docker destructive operation.',
    harm: 'local',
    binaries: ['docker'],
  },
  {
    pattern: /\bgit\s+push\b[^;|&]*?(?:\s--force\b|\s-f\b)/,
    decision: 'gate',
    name: 'git-force-push',
    why: 'Force-push rewrites history on a remote nobody here owns.',
    harm: 'reaches_out',
    binaries: ['git'],
  },
  {
    pattern: PACKAGE_PUBLISH,
    decision: 'gate',
    name: 'package-publish',
    why: 'Publishes to a public package registry.',
    harm: 'reaches_out',
    binaries: [
      'npm',
      'pnpm',
      'yarn',
      'bun',
      'cargo',
      'poetry',
      'uv',
      'flit',
      'hatch',
      'twine',
      'gem',
      'mvn',
      'gradle',
      'gradlew',
      'dotnet',
      'python',
      'python3',
    ],
  },

  {
    pattern: /\b169\.254\.169\.254\b/,
    decision: 'deny',
    name: 'cloud-metadata-ip',
    why: 'AWS/GCP/Azure cloud-metadata endpoint — common SSRF target.',
    harm: 'reaches_out',
  },
  {
    pattern: /\bmetadata\.google\.internal\b/,
    decision: 'deny',
    name: 'gcp-metadata',
    why: 'GCP metadata endpoint.',
    harm: 'reaches_out',
  },

  // Both leak into the transcript, so neither is 'local'.
  {
    pattern: /\b(printenv|env)\b(?!\s*\|.*grep)/,
    decision: 'warn',
    name: 'env-dump',
    why: 'Prints environment variables (may leak secrets to LLM output).',
    harm: 'reaches_out',
    binaries: ['printenv', 'env'],
  },
  {
    pattern: /\bcat\s+.*(\.env|\.npmrc|\.pypirc|\.aws|\.ssh|credentials)/i,
    decision: 'warn',
    name: 'secret-file-read',
    why: 'Reads a file likely to contain secrets.',
    harm: 'reaches_out',
    binaries: ['cat'],
  },
];

/** Severity rank for the dominant decision; higher is more severe. */
const SEVERITY = {
  allow: 0,
  warn: 1,
  gate: 2,
  deny: 3,
} satisfies Record<ApprovalDecision, number>;

function dominant(hits: readonly ApprovalRuleHit[]): ApprovalDecision {
  return hits.reduce<ApprovalDecision>(
    (acc, h) => (SEVERITY[h.decision] > SEVERITY[acc] ? h.decision : acc),
    'allow',
  );
}

/** Prefix words that keep the next word in command position. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(['sudo', 'command', 'exec', 'time', 'nice']);

/** Programs that run another program from an argument; binary-scoped rules fall back to whole-line matching under them. */
const INLINE_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'python', 'python3', 'perl', 'ruby', 'node', 'bun', 'deno',
  'xargs', 'ssh', 'env', 'nohup', 'timeout', 'watch', 'find', 'docker',
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Outside quotes, each ends a simple command. `&&` and `||` fall out of `&` and `|`. */
const COMMAND_BREAKS = new Set([';', '&', '|', '(', ')', '{', '}', '\n', '`']);

interface CommandScan {
  readonly invoked: ReadonlySet<string>;
  /** The line with quoted spans blanked; binary-scoped rules match against it. */
  readonly unquoted: string;
}

/**
 * One quote-aware pass: programs in command position (after env assignments and prefix words) and the
 * unquoted text. Over-collection is safe; under-collection is not.
 */
function scanCommand(command: string): CommandScan {
  const invoked = new Set<string>();
  let unquoted = '';
  let word = '';
  let atCommandStart = true;
  let quote: string | null = null;

  const endWord = () => {
    if (word.length === 0) return;

    if (atCommandStart && !ENV_ASSIGNMENT.test(word)) {
      const base = word.slice(word.lastIndexOf('/') + 1);
      invoked.add(base);

      if (!COMMAND_PREFIXES.has(base)) atCommandStart = false;
    }

    word = '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote !== null) {
      if (ch === quote) { quote = null; unquoted += ' '; }
      else word += ch;
      continue;
    }

    if (ch === '"' || ch === "'") { quote = ch; continue; }

    if (ch === '\\') { i++; continue; }

    unquoted += ch;

    if (ch === ' ' || ch === '\t') { endWord(); continue; }

    if (COMMAND_BREAKS.has(ch)) { endWord(); atCommandStart = true; continue; }

    if (ch === '$' && command[i + 1] === '(') { endWord(); atCommandStart = true; i++; continue; }

    word += ch;
  }

  endWord();

  return { invoked, unquoted };
}

/** Review a command for its executor. `executor` has no default so no caller silently picks a trust tier. */
export function reviewCommand(command: string, executor: string): ApprovalResult {
  const { invoked, unquoted } = scanCommand(command);
  let opaque = false;

  for (const binary of invoked) {
    if (INLINE_INTERPRETERS.has(binary)) { opaque = true; break; }
  }

  const agentsOwn = AGENT_OWN_EXECUTORS.has(executor);

  const hits: ApprovalRuleHit[] = [];

  for (const r of RULES) {
    // Rules without binaries, and every rule under an interpreter, match the raw text.
    if (r.binaries && !opaque) {
      if (!r.binaries.some((b) => invoked.has(b))) continue;

      if (!r.pattern.test(unquoted)) continue;
    } else if (!r.pattern.test(command)) continue;

    // Local harm on the agent's own machine is not gated; 'deny' is exempt.
    if (agentsOwn && r.harm === 'local' && r.decision !== 'deny') continue;
    hits.push({ decision: r.decision, rule: r.name, explanation: r.why });
  }

  return { decision: dominant(hits), hits };
}

/** Human-readable result for approval prompts and deny errors. */
export function formatApproval(result: ApprovalResult): string {
  if (result.decision === 'allow') return '';
  const lines = result.hits.map((h) => `• ${h.rule} (${h.decision}): ${h.explanation}`);

  return [`Approval review: ${result.decision}`, ...lines].join('\n');
}

export const APPROVAL_DENIED = 'Denied';

/** Plain union, not imported from config/store.ts: this file is a layergate subject source and stays import-free. */
export type ShellApprovalMode = 'strict' | 'allow_all' | 'deny_all';

/** The live policy each gated exec boundary reads at call time, so mode and channel changes apply to the next command. */
export interface ShellApprovalPolicy {
  mode(): ShellApprovalMode;
  /** Whether the owner granted this rule on this executor; consulted before asking. */
  granted?(grant: ApprovalGrant): boolean;
  /** Interactive channel for 'gate' under 'strict'. Null means nobody is listening: falls through to `deferrals`, else refuses. Read live. */
  requestApproval?: ((req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>) | null;
  /** Where an unanswered 'gate' decision is parked on the owner. */
  deferrals?: DeferredApprovalChannel;
  /** Remember 'allow_always' for every rule the command tripped on this executor. */
  remember?(grants: readonly ApprovalGrant[]): void;
  /** Refresh `mode()` and `granted()` before a decision; needed by facets whose grants live in the root's storage. */
  resolve?(): Promise<void>;
}

/** Default policy: 'strict' with nobody to ask, so 'gate' decisions are refused. */
export const STRICT_NO_CHANNEL_POLICY: ShellApprovalPolicy = { mode: () => 'strict' };

/** One spend of one grant. The spend counter makes late, replayed, or duplicate settles no-ops. */
export interface ApprovalSpend {
  readonly approvalId: string;
  readonly spend: number;
}

/** A spent grant's outcome. Only proven `did-not-run` refunds; an unsettled spend stays spent. */
export type ApprovalSpendOutcome =
  /** The boundary proved the command never reached its machine; the grant is refunded. */
  | 'did-not-run'
  | 'spent';

/**
 * Parks an unanswered 'gate' decision on the owner (vocabulary in safety/deferred-approval.ts; not imported,
 * see {@link ShellApprovalMode}). `run: true` means the grant is already spent; `settle` refunds unrun attempts.
 */
export interface DeferredApprovalChannel {
  park(req: ShellApprovalRequest):
    | { readonly run: true; readonly spent: ApprovalSpend }
    | { readonly run: false; readonly reason: 'denied' | 'unavailable'; readonly message: string };
  /** Close out a spend. Called once per spend on every returning path, never when unknown. Idempotent. */
  settle(spent: ApprovalSpend, outcome: ApprovalSpendOutcome): void;
}

/** The review minus rules the owner granted on this executor. Deny is never grantable. */
function afterGrants(review: ApprovalResult, policy: ShellApprovalPolicy, executor: string): ApprovalResult {
  if (review.decision !== 'gate' || !policy.granted) return review;

  const hits = review.hits.filter(
    (h) => h.decision !== 'gate' || !policy.granted?.({ rule: h.rule, executor }),
  );

  return hits.length === review.hits.length ? review : { decision: dominant(hits), hits };
}

/**
 * Wrap any exec-shaped function with the mode-aware approval gate; the single decision point for every
 * boundary that reaches a shell. `denyResult` writes a refusal into the result shape; `refusalCode` reads a
 * classification back out, never matching prose. A proven not-run code refunds a spent deferred grant.
 */
export interface ExecGateTuning<R> {
  readonly policy?: ShellApprovalPolicy;
  readonly refusalCode?: (result: R) => ErrorCode | null;
}

export function gateExec<R>(
  execute: (command: string, ...rest: unknown[]) => Promise<R>,
  denyResult: (error: KinuError) => R,
  executor: string,
  tuning: ExecGateTuning<R> = {},
): (...args: unknown[]) => Promise<R> {
  const policy = tuning.policy ?? STRICT_NO_CHANNEL_POLICY;
  const refusalCode = tuning.refusalCode;

  // Rest args keep this assignable to `ExecutorProvider['tools'][name].execute` and to `Shell.exec`.
  return async (...args) => {
    const [command, ...rest] = args;
    const cmd = String(command);

    const decision = await decideApproval(
      { command: cmd, executor }, reviewCommand(cmd, executor), policy,
    );

    if (!decision.run) return denyResult(decision.error);
    const result = await execute(cmd, ...rest);

    if (decision.spent) {
      const code = refusalCode?.(result) ?? null;
      policy.deferrals?.settle(
        decision.spent,
        code !== null && CODE_WORK_DID_NOT_START[code] ? 'did-not-run' : 'spent',
      );
    }

    return result;
  };
}

/**
 * The mode/grant/channel/deferral ladder over any reviewable action. Standing grants apply here.
 * A `run: true` from a replayed park carries its spend; the caller must settle it once the outcome is known.
 */
async function decideApproval(
  subject: { readonly command: string; readonly executor: string },
  rawReview: ApprovalResult,
  policy: ShellApprovalPolicy,
): Promise<
  | { readonly run: true; readonly spent?: ApprovalSpend }
  | { readonly run: false; readonly error: KinuError }
> {
  const { command: cmd, executor } = subject;
  await policy.resolve?.();
  const mode = policy.mode();
  const review = afterGrants(rawReview, policy, executor);
  const refuse = (reason: ErrorCode, message: string) => ({ run: false, error: new KinuError(reason, message) } satisfies { run: false; error: KinuError });
  let spent: ApprovalSpend | undefined;

  if (review.decision === 'deny') {
    return refuse('denied', `${APPROVAL_DENIED} — ${formatApproval(review)}`);
  }

  if (review.decision === 'gate') {
    if (mode === 'allow_all') {
      diagnostics.failure(
        'approval.gate_bypassed',
        new KinuError('unsupported', 'allow_all mode cannot ask the owner; the gated command ran unapproved'),
        { executor, rules: review.hits.map((h) => h.rule).join(',') },
      );
    } else {
      // 'deny_all' never asks; null channel means nobody is listening.
      const outcome = mode === 'strict' && policy.requestApproval
        ? await policy.requestApproval({ command: cmd, executor, review })
        : null;

      if (outcome === null) {
        // Under 'strict', no answer parks on the owner if a queue is wired; the queue is consulted only after the channel declines.
        const parked = mode === 'strict'
          ? policy.deferrals?.park({ command: cmd, executor, review })
          : undefined;

        if (parked && !parked.run) return refuse(parked.reason, parked.message);

        if (!parked) {
          // Do not say "nobody to ask" under deny_all; it would invite re-asking.
          return mode === 'deny_all'
            ? refuse('denied', `NOT RUN — refused by standing policy (deny_all) — ${formatApproval(review)}`)
            : refuse('unavailable', `NOT RUN — needs owner approval, nobody to ask — ${formatApproval(review)}`);
        }

        // A parked grant was just spent; execute and carry the spend out.
        spent = parked.spent;
      } else if (!approvalGrants(outcome)) {
        return refuse('denied', `${APPROVAL_DENIED} by the owner — ${formatApproval(review)}`);
      } else if (outcome === 'allow_always') {
        policy.remember?.(gatedGrants(review, executor));
      }
    }
  }

  if (review.decision === 'warn') {
    if (mode === 'deny_all') {
      return refuse('denied', `${APPROVAL_DENIED} (deny_all mode) — ${formatApproval(review)}`);
    }

    diagnostics.failure(
      'approval.warn_unenforced',
      new KinuError('unsupported', 'a warn-level review is not put to the owner; the command ran'),
      { executor, rules: review.hits.map((h) => h.rule).join(',') },
    );
  }

  return spent === undefined ? { run: true } : { run: true, spent };
}

/** Grants an 'always' answer buys: each asked rule, on its executor. */
export function gatedGrants(review: ApprovalResult, executor: string): ApprovalGrant[] {
  return review.hits.filter((h) => h.decision === 'gate').map((h) => ({ rule: h.rule, executor }));
}

/** Whether every grant in `child` is in `parent`: the facet invariant. */
export function grantsAreSubset(
  child: readonly ApprovalGrant[],
  parent: readonly ApprovalGrant[],
): boolean {
  const held = new Set(parent.map(formatApprovalGrant));

  return child.every((g) => held.has(formatApprovalGrant(g)));
}

/** A facet's grants: the root's set (`own === null` inherits) intersected with its own narrowing. */
export function resolveInheritedGrants(source: {
  readonly root: readonly ApprovalGrant[];
  readonly own: readonly ApprovalGrant[] | null;
}): ApprovalGrant[] {
  const root = [...source.root];

  if (source.own === null || source.own.length === 0) return root;
  const held = new Set(root.map(formatApprovalGrant));

  return source.own.filter((g) => held.has(formatApprovalGrant(g)));
}

export interface InheritedApprovalSource {
  /** The root's mode and grants; fetched once per decision via {@link ShellApprovalPolicy.resolve}. */
  fetchRoot(): Promise<{ mode: ShellApprovalMode; grants: readonly ApprovalGrant[] }>;
  /** This facet's own narrowing; `null` inherits the root's set. */
  ownGrants(): readonly ApprovalGrant[] | null;
}

/**
 * A facet's approval policy: no `remember` or `requestApproval`, so a facet cannot widen its own reach.
 * Fails closed (`strict`, nothing granted) until the first resolve lands.
 */
export function createInheritedApprovalPolicy(
  source: InheritedApprovalSource,
): ShellApprovalPolicy {
  let mode: ShellApprovalMode = 'strict';
  let grants: readonly ApprovalGrant[] = [];

  return {
    async resolve() {
      const root = await source.fetchRoot();
      mode = root.mode;
      grants = resolveInheritedGrants({ root: root.grants, own: source.ownGrants() });
    },
    mode: () => mode,
    granted: (grant) => holdsGrant(grants, grant),
  };
}
