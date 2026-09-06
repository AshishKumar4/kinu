/**
 * Approval gate — does this command need the owner's decision, and WHERE is
 * it about to run?
 *
 * A pre-execution pass over every command that reaches a real shell:
 *   • 'allow'   — nothing to decide here; execute immediately
 *   • 'warn'    — unusual but not destructive; log + execute
 *   • 'gate'    — the owner decides
 *   • 'deny'    — never executes, on any executor
 *
 * TWO THINGS THIS FILE GETS RIGHT THAT A FLAT PATTERN TABLE CANNOT.
 *
 * 1. A decision is a function of (rule, EXECUTOR). `rm -rf node_modules` in
 *    the agent's own workspace is housekeeping; the identical string against
 *    the owner's laptop is their real machine. A table matched on the command
 *    string alone cannot tell those apart, so it gated both — which is why
 *    ordinary agent work spent the owner's attention on nothing. Each rule
 *    declares where its harm LANDS ({@link ApprovalHarm}); each executor is
 *    either the agent's own machine or somebody else's. Local harm on the
 *    agent's own machine is not the owner's decision. Everything that reaches
 *    past the executor — a remote, a registry, the transcript, the host's
 *    cloud identity — is, wherever it was typed. One rule table, resolved per
 *    executor; not a table per executor.
 *
 * 2. A rule fires on a command that is INVOKED, not on a string that is
 *    mentioned. `grep -rn "rm -rf" .` and `echo "run sudo"` mutate nothing,
 *    and a substring match gated both. Rules that name a binary now require
 *    that binary in command position ({@link invokedBinaries}). The exception
 *    is deliberate: when the line hands a program to an interpreter, whatever
 *    it runs is opaque to a shell-word scan, so those rules fall back to
 *    matching the whole line.
 *
 * 'deny' is absolute and is unchanged by either of the above: same patterns,
 * whole-line, every executor. It is the tier that answers "never, anywhere",
 * and a tier that softens is not that tier.
 *
 * Patterns are conservative; the agent can always work around them by
 * splitting commands. This is a guardrail against accidents, not an adversary
 * model.
 *
 * Influences come from Hermes's tools/approval.py (battle-tested regex set
 * for sudo / rm -rf / shell-meta escapes / cloud-metadata SSRF). Source
 * patterns ported here aren't a 1:1 copy — that file is 62K — but follow
 * the same intuition + add Cloudflare-Workers-specific deny rules.
 */

import { CODE_WORK_DID_NOT_START, diagnostics, KinuError, type ErrorCode } from '../obs/index';

export type ApprovalDecision = 'allow' | 'warn' | 'gate' | 'deny';

/**
 * Where a rule's harm lands, which is what makes a decision executor-sensitive.
 *
 *   'local'       — the damage is confined to the machine the command runs on.
 *                   Whether that matters depends entirely on whose machine it
 *                   is: a wiped scratch workspace is a re-clone, a wiped laptop
 *                   is the owner's life.
 *   'reaches_out' — the effect leaves the executor. A force-push rewrites a
 *                   remote, `npm publish` is public, an env dump lands in the
 *                   transcript, a metadata fetch steals the host's identity.
 *                   None of that gets safer for having been typed on a
 *                   disposable box.
 */
export type ApprovalHarm = 'local' | 'reaches_out';

/**
 * Executors whose local state belongs to the agent itself — its own workspace
 * filesystem and its own provisioned container. Local-harm rules are not the
 * owner's decision on these.
 *
 * Everything else is somebody else's machine and is NOT listed: the owner's
 * `laptop`, a fork's `parent` workspace, and any executor kind added later.
 * Membership is opt-in precisely so a new executor fails closed.
 */
const AGENT_OWN_EXECUTORS: ReadonlySet<string> = new Set(['workspace', 'sandbox']);

export interface ApprovalRuleHit {
  readonly decision: ApprovalDecision;
  readonly rule: string;
  readonly explanation: string;
}

export interface ApprovalResult {
  readonly decision: ApprovalDecision;
  /** Every rule that fired, with the decision it carries ON THIS EXECUTOR.
   *  Rules whose harm the executor cannot suffer are not hits at all. */
  readonly hits: readonly ApprovalRuleHit[];
}

/** What an interactive approval channel is asked about: the command, where it
 *  would run, and the review explaining why anyone is being asked. */
export interface ShellApprovalRequest {
  readonly command: string;
  /** The executor the command is bound for — `workspace`, `sandbox`,
   *  `laptop`, `parent`. Part of the question, not decoration: the same
   *  string is a different request on a different machine. */
  readonly executor: string;
  readonly review: ApprovalResult;
}

/** A channel's answer. 'allow'/'deny' apply to this command only; 'allow_always'
 *  additionally grants every rule this command tripped, on this executor
 *  ({@link ApprovalGrant}) — not "stop gating everything". */
export type ShellApprovalOutcome = 'allow' | 'allow_always' | 'deny';

/** Whether an outcome lets the command run. */
export function approvalGrants(outcome: ShellApprovalOutcome): boolean {
  return outcome === 'allow' || outcome === 'allow_always';
}

/**
 * The unit of trust a standing grant is written in: one rule, on one executor.
 *
 * Why this unit and not another. An exact command string never matches twice —
 * the next `rm -rf` has a different path, so "don't ask again" would ask again.
 * A bare rule name ("allow rm forever") throws away the only distinction that
 * makes the gate worth having. The rule is already the vocabulary the gate
 * reasons in and the owner reads, the executor is already the thing that
 * decides whether the rule matters, and the product of the two is small enough
 * to list, review and revoke one line at a time.
 */
export interface ApprovalGrant {
  readonly rule: string;
  readonly executor: string;
}

/** The stored spelling of a grant. One token, so a set of them is a plain
 *  comma-separated config value like every other list this agent stores. */
export function formatApprovalGrant(grant: ApprovalGrant): string {
  return `${grant.rule}@${grant.executor}`;
}

/** Read a stored grant back. Anything malformed is not a grant — a config
 *  value that cannot be parsed must never widen what runs. */
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
  /** The binaries this rule is about. Present ⇒ the rule only fires when one
   *  of them is actually invoked (see {@link invokedBinaries}). Absent ⇒ the
   *  pattern describes the shape of the whole line, not a program: a fork
   *  bomb, a pipe into a shell, a metadata address that can sit in any
   *  argument. Deny rules deliberately carry none. */
  binaries?: readonly string[];
}

/**
 * Every ecosystem's "ship this to the world" command, not only JavaScript's.
 *
 * Pushing a package to a public registry is irreversible and outward-facing
 * whichever language types it, so the rule that says so has to recognise all
 * of them. Matching `npm publish` alone meant an identical Rust, Python, Ruby,
 * Java or .NET task published with no approval prompt: the `why` was already
 * language-agnostic while the pattern was not.
 *
 * The binary list beside it is load-bearing, not decoration — `binaries` gates
 * whether the rule fires at all, so a pattern extended without it is a rule
 * that reads as fixed and never matches.
 */
const PACKAGE_PUBLISH = new RegExp(
  [
    /\b(?:npm|pnpm|yarn|bun|cargo|poetry|uv|flit|hatch)\s+publish\b/, // JS, Rust, Python
    /\btwine\s+upload\b/, // Python, including `python -m twine`
    /\bgem\s+push\b/, // Ruby
    /\bmvn\s+deploy\b|\bgradlew?\s+[^&|;]*\bpublish[A-Za-z]*/, // Java
    /\bdotnet\s+nuget\s+push\b/, // .NET
  ]
    .map((r) => r.source)
    .join('|'),
);

/**
 * Default rule set — the ONE table, resolved per executor by
 * {@link reviewCommand}. There is no per-executor copy of it.
 *
 * Adding a rule: prefer specificity over breadth, and say where the harm
 * lands. A rule with `harm: 'local'` is claiming the damage stops at the
 * machine, which is what buys the agent an ungated shell on its own box.
 */
const RULES: Rule[] = [
  // ── DENY: obviously destructive or filesystem-corrupting ─────────
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

  // ── GATE: privileged or sensitive operations ─────────────────────
  {
    // Just the word: the leading-whitespace guard it used to carry was a proxy
    // for "in command position", which `binaries` now decides properly — and
    // the proxy was wrong, missing both `/usr/bin/sudo x` and `ssh box "sudo x"`.
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

  // ── DENY: prompt-injection / cloud-metadata SSRF ─────────────────
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

  // ── WARN: secrets exposure pattern ───────────────────────────────
  // Both leak into the transcript, which is the same place whichever machine
  // the command ran on — so neither is 'local' and neither softens.
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

/**
 * Severity rank for picking the dominant decision when multiple rules fire.
 * Higher number = more severe.
 */
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

/** Words that run whatever comes after them, so the thing after them is still
 *  in command position. Kept to the ones that actually appear in front of a
 *  gated binary; anything else is either rare or already an interpreter. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(['sudo', 'command', 'exec', 'time', 'nice']);

/**
 * Programs that take another program in an argument. Whatever they run is not
 * a shell word this scan can see — `python -c "os.system('rm -rf /home')"`,
 * `bash -c '…'`, `xargs rm -r`, `ssh host '…'` — so when one of these is
 * invoked, binary-scoped rules fall back to matching the whole line, exactly
 * as they did before command-position matching existed. Over-gating an
 * interpreter is the safe direction.
 */
const INLINE_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'python', 'python3', 'perl', 'ruby', 'node', 'bun', 'deno',
  'xargs', 'ssh', 'env', 'nohup', 'timeout', 'watch', 'find', 'docker',
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Outside quotes, each of these ends a simple command, so the next word is a
 *  program name again. `&&` and `||` fall out of `&` and `|`. */
const COMMAND_BREAKS = new Set([';', '&', '|', '(', ')', '{', '}', '\n', '`']);

/** What one quote-aware pass over a command line yields. */
interface CommandScan {
  /** Every program invoked, by basename. */
  readonly invoked: ReadonlySet<string>;
  /** The line with every quoted span replaced by a space — the text a
   *  binary-scoped rule is matched against, so that `git log --grep "git
   *  reset --hard"` is a search and not a reset. The cost is that a rule
   *  phrase spelled with quotes around it (`cat ".env"`) stops matching; that
   *  is a warn-tier spelling nobody writes, and the alternative is reading a
   *  quoted argument as a command. */
  readonly unquoted: string;
}

/**
 * Read a command line once: what it invokes, and what it says outside quotes.
 *
 * A word counts as a program only in command position — the start of the
 * line, or after a shell operator — with environment assignments and
 * `sudo`-style prefixes skipped through. Quotes are tracked so an operator
 * inside a string does not open a new command position, which is why
 * `echo "a; rm -rf /tmp"` stops being a gated command.
 *
 * Over-collection is safe and under-collection is not, so a prefix word keeps
 * command position open even across its flags: `sudo -u bob rm -rf /` yields
 * `sudo`, `-u`, `bob` and `rm`, and only the real binaries match anything.
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
    const ch = command[i]!;
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

/**
 * Review a command for the executor it is bound for.
 *
 * `executor` is required and has no default: every boundary that reaches a
 * shell knows which machine it is, and a default would silently pick a trust
 * tier for a caller that forgot to say.
 */
export function reviewCommand(command: string, executor: string): ApprovalResult {
  const { invoked, unquoted } = scanCommand(command);
  let opaque = false;
  for (const binary of invoked) {
    if (INLINE_INTERPRETERS.has(binary)) { opaque = true; break; }
  }
  const agentsOwn = AGENT_OWN_EXECUTORS.has(executor);

  const hits: ApprovalRuleHit[] = [];
  for (const r of RULES) {
    // A rule that names no binary describes the shape of the whole line — a
    // fork bomb, a pipe into a shell, a metadata address that can sit in any
    // argument — and so does every rule when an interpreter is holding the
    // program. Both match the raw text, which is exactly what they matched
    // before this file knew what a command position was.
    if (r.binaries && !opaque) {
      if (!r.binaries.some((b) => invoked.has(b))) continue;
      if (!r.pattern.test(unquoted)) continue;
    } else if (!r.pattern.test(command)) continue;
    // Local harm on the agent's own machine is the agent's own business.
    // 'deny' is exempt: it means never, and never does not have exceptions.
    if (agentsOwn && r.harm === 'local' && r.decision !== 'deny') continue;
    hits.push({ decision: r.decision, rule: r.name, explanation: r.why });
  }
  return { decision: dominant(hits), hits };
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
 * The two markers every approval REFUSAL carries, named here because this file
 * writes them and a reader must not keep a second copy of the strings.
 *
 * A denied command reaches the ledger as an ordinary non-zero exit whose stderr
 * is this message, so the durable row is indistinguishable from a failing build
 * unless something looks for these. Measured on a live run: three attempts at
 * `curl -fsSL https://bun.sh/install | bash` were refused by the `pipe-to-bash`
 * rule and counted as the WORK failing — the safety ladder working correctly,
 * filed as the agent's command being broken.
 */
export const APPROVAL_DENIED = 'Denied';
export const APPROVAL_REVIEW_LABEL = 'Approval review:';

/** Whether `text` is a refusal this gate wrote, rather than output that merely
 *  mentions one of the words. Both markers are required for that reason. */
export function citesApprovalDenial(text: string): boolean {
  return text.includes(APPROVAL_DENIED) && text.includes(APPROVAL_REVIEW_LABEL);
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
  /** Has the owner already said yes to this rule on this executor, for good?
   *  A live read of the stored grants, consulted BEFORE anyone is asked — the
   *  point of a standing grant is that nobody is asked again. */
  granted?(grant: ApprovalGrant): boolean;
  /** The interactive channel consulted for a 'gate' decision under 'strict'.
   *  Omitted, or resolving null, means nobody is listening — 'strict' falls
   *  through to `deferrals` if one is wired, and otherwise keeps its
   *  explanatory refusal. A live read too: a surface may attach/detach the
   *  channel after the boundary was wrapped. */
  requestApproval?(req: ShellApprovalRequest): Promise<ShellApprovalOutcome | null>;
  /** Where a 'gate' decision goes when nobody answered — parked on the owner
   *  rather than refused on their behalf. See {@link DeferredApprovalChannel}. */
  deferrals?: DeferredApprovalChannel;
  /** Remember the owner's 'allow_always'. Called with every rule the command
   *  tripped on this executor, so the next command of the same kind in the
   *  same place does not ask. */
  remember?(grants: readonly ApprovalGrant[]): void;
  /**
   * Bring `mode()` and `granted()` up to date before they are read.
   *
   * `mode`/`granted` are synchronous because every boundary that reaches a
   * shell reads them inline. That is fine when the answers live in the
   * caller's own storage, and wrong for a facet — a head, a subordinate —
   * whose grants live in the ROOT workspace's storage, one DO away and
   * reachable only by RPC. Without this, a facet reads its own empty
   * `agent_config` and re-asks for consent the owner already gave.
   *
   * Called once per decision, before anything is read, and only where the
   * answers are not local. Omitted for a root actor: its storage IS the
   * source, so there is nothing to resolve.
   */
  resolve?(): Promise<void>;
}

/** The conservative default every gated boundary falls back to when no
 *  policy is supplied: 'strict', with nobody to ask — 'gate' decisions are
 *  refused with the explanatory message, never silently allowed. Matches
 *  what `run` always defaulted to before this policy existed. */
export const STRICT_NO_CHANNEL_POLICY: ShellApprovalPolicy = { mode: () => 'strict' };

/**
 * One SPEND of one grant — which row the owner approved, and which spend of
 * that row this is.
 *
 * The spend counter is what keeps a refund from becoming a second way to
 * grant. A settle names its own spend, so a late or replayed settle of an
 * earlier spend cannot touch a grant that a later attempt already holds, and
 * settling the same spend twice is a no-op. An opaque pair here rather than a
 * bare id for exactly that reason.
 */
export interface ApprovalSpend {
  readonly approvalId: string;
  readonly spend: number;
}

/**
 * What the gate learned about a spent grant once the wrapped execute returned.
 *
 * Two answers, not three, and the asymmetry is the point: `did-not-run` must be
 * PROVEN, and everything else — it ran, it failed on the machine, nobody can
 * say — is one answer, because they carry one consequence. A gate that never
 * settles at all (a throw, a crash, a process that dies) leaves the grant
 * spent, which is the same safe reading arrived at by silence.
 */
export type ApprovalSpendOutcome =
  /** The boundary's own classification establishes that the command never
   *  reached its machine. The grant goes back to the state the owner approved
   *  it in, and stays theirs to spend. */
  | 'did-not-run'
  /** Anything else. The approval is consumed for good. */
  | 'spent';

/**
 * What the gate does with a 'gate' decision nobody is around to answer:
 * park it on the owner instead of refusing on their behalf.
 *
 * The whole vocabulary of parking — ids, durable rows, the words the model
 * reads, the wake when the owner decides — belongs to
 * safety/deferred-approval.ts. What crosses into THIS file is two verbs,
 * because this file is a layergate subject source and stays import-free (see
 * {@link ShellApprovalMode}); a `DeferredApproval` type here would drag the
 * queue's whole import closure into the safety-gate layer.
 *
 * `run: true` is the only answer that lets the command through, and by the
 * time it is returned the owner's grant is already spent — so a crash between
 * the decision and the command costs an approval rather than granting one
 * twice. That is deliberate and it stays. What it cost before `settle` existed
 * was an approval per ATTEMPT: a command the gate let through, that then
 * reached an executor which was not there, spent the grant on nothing and sent
 * the owner the same question again. `settle` is how the gate reports which of
 * those two things happened.
 */
export interface DeferredApprovalChannel {
  park(req: ShellApprovalRequest):
    | { readonly run: true; readonly spent: ApprovalSpend }
    | { readonly run: false; readonly message: string };
  /** Close out a spend `park` reported. Called exactly once per spend on every
   *  path the wrapped execute RETURNS on; never called when its outcome is
   *  unknown. Idempotent, and safe to call late. */
  settle(spent: ApprovalSpend, outcome: ApprovalSpendOutcome): void;
}

/** The review with the owner's standing grants taken out of it: a rule they
 *  have already blessed on this executor is no longer something to ask about.
 *  Deny is never grantable — it is not a question. */
function afterGrants(review: ApprovalResult, policy: ShellApprovalPolicy, executor: string): ApprovalResult {
  if (review.decision !== 'gate' || !policy.granted) return review;
  const hits = review.hits.filter(
    (h) => h.decision !== 'gate' || !policy.granted?.({ rule: h.rule, executor }),
  );
  return hits.length === review.hits.length ? review : { decision: dominant(hits), hits };
}

/**
 * Wrap ANY exec-shaped function — a `Shell.exec`, an `ExecutorProvider`
 * tool's `execute` — with the FULL mode-aware approval gate. This is the one
 * implementation of "should this command run" used at every boundary a
 * command actually reaches a shell: `run`'s workspace/router dispatch and
 * every ExecutorProvider's `exec`/`startProcess` (see execution/approval.ts),
 * so `run { command }` and the same command reached through codemode
 * (`workspace.exec` and every registered executor's `exec`) answer to
 * the identical decision instead of one tool remembering to ask and the rest
 * not.
 *
 * `executor` names the machine this boundary reaches. It is what makes the
 * decision scope-aware, so it is a required argument rather than something
 * inferred: a boundary that cannot say where it runs has no business gating.
 *
 * `denyResult` shapes a gate/deny message into the wrapped function's own
 * return type — a bare string for a codemode tool, `{stdout,stderr,exitCode}`
 * for a raw `Shell`.
 *
 * `refusalCode` is its mirror: it reads a CLASSIFICATION back out of that same
 * return type. Together they are the whole adapter between this gate and a
 * boundary's result shape — one writes a message in, the other reads a code
 * out — and the policy built on the code stays here, in one place, rather than
 * once per executor. A boundary whose results carry no classification omits
 * it; that costs it the refund below and nothing else, and it is the honest
 * answer for a shape with no code in it. NEVER match on prose: a refusal is a
 * code, and text that merely reads like one is a command's own output.
 *
 * THE REFUND. A deferred grant is spent BEFORE the command runs, so a crash
 * between the two costs an approval rather than granting one twice. That gives
 * "one approval, one attempt", where the product wants "one approval, one
 * EXECUTION" — an attempt that never reached its machine spent the owner's
 * grant on nothing and sent them the same question again. So the gate reports
 * every spend back to the channel with what it now knows: a code that PROVES
 * no execution happened gives the grant back, and anything else — it ran, it
 * failed on the machine, nobody can say — consumes it. A throw settles
 * nothing, because a throw establishes nothing.
 */
export function gateExec<R>(
  execute: (command: string, ...rest: unknown[]) => Promise<R>,
  denyResult: (message: string) => R,
  executor: string,
  policy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY,
  refusalCode?: (result: R) => ErrorCode | null,
): (...args: unknown[]) => Promise<R> {
  // A rest-args signature — not `(command: string, ...)` — so the wrapped
  // function stays assignable to `ExecutorProvider['tools'][name].execute`
  // (`(...args: unknown[]) => Promise<unknown>`) as well as to a narrower
  // fixed-shape target like `Shell.exec`.
  return async (...args) => {
    const [command, ...rest] = args;
    const cmd = String(command);
    const decision = await decideApproval(
      { command: cmd, executor }, reviewCommand(cmd, executor), policy,
    );
    if (!decision.run) return denyResult(decision.message);
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
 * The mode/grant/channel/deferral ladder, over ANY reviewable action.
 *
 * Split out of {@link gateExec} because a command is not the only thing the
 * owner could be asked about — an egress request that would carry one of
 * their secrets is the same question (mode, then standing grants, then the
 * interactive channel, then the deferral queue) about a different subject —
 * and two copies of this ladder would be two places for "strict with nobody
 * listening" to drift into a silent allow. Private, because {@link gateExec}
 * is the one boundary that runs it today: the egress-binding consent
 * `egress-gate.ts` describes is not built, and a Slate binding passes the
 * agent's own capability gated as the agent's own call is, so it asks nothing
 * of its own. A second subject exports it again when it arrives.
 *
 * `subject.command` is the human-readable action the owner is shown; for a
 * shell boundary it is literally the command line. Standing grants are
 * applied here, not by the caller: a rule the owner already blessed on this
 * executor must stop the asking no matter which boundary asked.
 *
 * A `run: true` reached by replaying a parked grant carries the SPEND it made.
 * The caller owns what happens next, so the caller is the only one who can say
 * whether the action happened — it must hand that spend back to
 * {@link DeferredApprovalChannel.settle} once it knows, and leave it unsettled
 * when it never finds out. {@link gateExec} does this for every gated command
 * boundary.
 */
async function decideApproval(
  subject: { readonly command: string; readonly executor: string },
  rawReview: ApprovalResult,
  policy: ShellApprovalPolicy,
): Promise<
  | { readonly run: true; readonly spent?: ApprovalSpend }
  | { readonly run: false; readonly message: string }
> {
  const { command: cmd, executor } = subject;
  // Before anything is read: a facet's answers live in its root's storage.
  await policy.resolve?.();
  const mode = policy.mode();
  const review = afterGrants(rawReview, policy, executor);
  const deny = (message: string) => ({ run: false, message }) as const;
  /** The grant a park replayed, if one was. Held across the ladder because the
   *  spend happens mid-decision and is reported at the end. */
  let spent: ApprovalSpend | undefined;
  if (review.decision === 'deny') {
    return deny(`${APPROVAL_DENIED} — ${formatApproval(review)}`);
  }
  if (review.decision === 'gate') {
    if (mode === 'allow_all') {
      diagnostics.failure(
        'approval.gate_bypassed',
        new KinuError('unsupported', 'allow_all mode cannot ask the owner; the gated command ran unapproved'),
        { executor, rules: review.hits.map((h) => h.rule).join(',') },
      );
    } else {
      // 'deny_all' never asks. Under 'strict' a connected channel gets to
      // put the decision to the user; null means nobody is listening.
      const outcome = mode === 'strict' && policy.requestApproval
        ? await policy.requestApproval({ command: cmd, executor, review })
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
        const parked = mode === 'strict'
          ? policy.deferrals?.park({ command: cmd, executor, review })
          : undefined;
        if (parked && !parked.run) return deny(parked.message);
        if (!parked) {
          // 'deny_all' is an answer the owner already gave; 'strict' with no
          // queue and no channel is an absence. Saying "nobody to ask" under
          // deny_all would invite the agent to keep asking.
          return deny(mode === 'deny_all'
            ? `NOT RUN — refused by standing policy (deny_all) — ${formatApproval(review)}`
            : `NOT RUN — needs owner approval, nobody to ask — ${formatApproval(review)}`);
        }
        // parked.run — the owner approved this command while the agent was
        // away and the grant has just been spent; fall through to execute,
        // carrying the spend out so the caller can close it.
        spent = parked.spent;
      } else if (!approvalGrants(outcome)) {
        return deny(`${APPROVAL_DENIED} by the owner — ${formatApproval(review)}`);
      } else if (outcome === 'allow_always') {
        // Scoped to exactly what was asked: these rules, this executor.
        policy.remember?.(gatedGrants(review, executor));
      }
    }
  }
  if (review.decision === 'warn') {
    if (mode === 'deny_all') {
      return deny(`${APPROVAL_DENIED} (deny_all mode) — ${formatApproval(review)}`);
    }
    diagnostics.failure(
      'approval.warn_unenforced',
      new KinuError('unsupported', 'a warn-level review is not put to the owner; the command ran'),
      { executor, rules: review.hits.map((h) => h.rule).join(',') },
    );
  }
  return spent === undefined ? { run: true } : { run: true, spent };
}

/** The grants an 'always' answer to this review buys: every rule that was
 *  actually asked about, on the executor it was asked about. Nothing wider. */
export function gatedGrants(review: ApprovalResult, executor: string): ApprovalGrant[] {
  return review.hits.filter((h) => h.decision === 'gate').map((h) => ({ rule: h.rule, executor }));
}

/** Whether every grant in `child` is also in `parent` — the invariant a facet
 *  must satisfy. Written as a predicate, not an assertion, because it is both
 *  the thing {@link resolveInheritedGrants} guarantees and the thing a test
 *  and a gate check independently. */
export function grantsAreSubset(
  child: readonly ApprovalGrant[],
  parent: readonly ApprovalGrant[],
): boolean {
  const held = new Set(parent.map(formatApprovalGrant));
  return child.every((g) => held.has(formatApprovalGrant(g)));
}

/**
 * The grants a facet actually holds: its root's set, or a narrowing of it.
 *
 * Every agent in a workspace shares one container and one set of capabilities
 * — the ones the owner granted — or a SUBSET. Two failure modes this rules
 * out, and both were live:
 *
 *   Too few. A facet's `agent_config` is its own and nobody writes grants to
 *   it, so a head read an empty list and re-asked for consent the owner had
 *   already given on the workspace. `own === null` means "this facet has said
 *   nothing about its own reach", which is not the same as "it has none" —
 *   it inherits.
 *
 *   Too many. A facet that recorded its own grant could otherwise out-reach
 *   the parent it was forked from. Intersection makes that unrepresentable:
 *   a grant the root does not hold cannot survive, whatever the facet stored.
 */
export function resolveInheritedGrants(source: {
  readonly root: readonly ApprovalGrant[];
  readonly own: readonly ApprovalGrant[] | null;
}): ApprovalGrant[] {
  const root = [...source.root];
  if (source.own === null || source.own.length === 0) return root;
  const held = new Set(root.map(formatApprovalGrant));
  return source.own.filter((g) => held.has(formatApprovalGrant(g)));
}

/** What a facet needs fetched from its root to decide anything. */
export interface InheritedApprovalSource {
  /** The root workspace's standing mode and grants, over whatever transport
   *  reaches it. Called once per decision via
   *  {@link ShellApprovalPolicy.resolve}. */
  fetchRoot(): Promise<{ mode: ShellApprovalMode; grants: readonly ApprovalGrant[] }>;
  /** This facet's own narrowing, if it has ever recorded one. `null` — the
   *  normal case — means it inherits the root's set whole. */
  ownGrants(): readonly ApprovalGrant[] | null;
}

/**
 * A facet's approval policy: the owner's decisions, made on the workspace,
 * applied to an agent that is not the workspace.
 *
 * Deliberately carries no `remember` and no `requestApproval`. A facet has no
 * chat surface the owner is watching and no needs-you queue of its own, and a
 * facet that could record a grant would be a facet that can widen its own
 * reach. Approving is the root's job; a facet only ever spends what the root
 * already granted.
 *
 * Until the first {@link ShellApprovalPolicy.resolve} lands this fails CLOSED
 * — `strict`, nothing granted — so an unreachable root narrows a facet
 * instead of unleashing it.
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
    granted: (grant) => grants.some(
      (g) => g.rule === grant.rule && g.executor === grant.executor,
    ),
  };
}
