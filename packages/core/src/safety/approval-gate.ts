/**
 * Approval gate: 'allow', 'warn', 'gate' (the owner decides) or 'deny' (never). A decision depends on the rule and
 * whose files the executor holds; binary-scoped rules fire only on invoked binaries, or on the whole line under an
 * interpreter. Against accidents, not an adversary.
 */

import { CODE_WORK_DID_NOT_START, diagnostics, KinuError, type ErrorCode } from '../obs/index';

export type ApprovalDecision = 'allow' | 'warn' | 'gate' | 'deny';

/** Where a rule's harm lands: 'local' (the executing machine only) or 'reaches_out' (leaves the executor). */
export type ApprovalHarm = 'local' | 'reaches_out';

/** 'agent': its own disposable state, where local harm is not gated; 'user': anything else. Declared, never read
 *  from a name. */
export type FilesOwner = 'agent' | 'user';

export interface GatedExecutor {
  readonly name: string;
  readonly filesOwner: FilesOwner;
  readonly shellSession?: ShellSession;
}

export interface ShellCwd {
  readonly home: string;
  readonly cwd: string;
  readonly mayBeUsers: boolean;
}

export interface ShellSession {
  readonly home: string;
  readonly userRoots: () => readonly string[];
  /** Behind earlier calls, so a review sees their `cd`s. */
  serial<R>(call: () => Promise<R>): Promise<R>;
  /** Where a call without its own `cwd` starts. */
  at(): Promise<ShellCwd>;
  /** A foreground call without a `cwd` exited. */
  ran(command: string, exitCode: number): void;
}

export interface ShellSessionOptions {
  readonly home: string;
  readonly userRoots: () => readonly string[];
  /** False when the box starts every call at home. */
  readonly keepsCwd: boolean;
  /** Its cwd as an earlier process left it; null: unreadable. */
  readonly stored?: () => Promise<string | null>;
}

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

function approvalGrants(outcome: ShellApprovalOutcome): boolean {
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
  /** When present, the rule fires only if one of these is invoked; absent, on the whole line. Deny rules carry none. */
  binaries?: readonly string[];
}

/** Long options taking the next word as a value (git.c). */
const GIT_VALUE_OPTION = '(?:git-dir|work-tree|namespace|config-env|super-prefix)';

/** `git` and its global options; each word parses one way, so a failed match stays linear. */
const GIT = String.raw`\bgit(?:\s+(?:(?:-[Cc]|--${GIT_VALUE_OPTION})\s+\S+|-[pP]|--(?!${GIT_VALUE_OPTION}(?:\s|$))[\w-]+(?:=\S+)?))*\s+`;

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

/** Default rules, resolved by {@link reviewCommand}. `harm: 'local'`: damage stops at the machine. */
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
    pattern: new RegExp(`${GIT}reset\\s+--hard`),
    decision: 'gate',
    name: 'git-reset-hard',
    why: 'Discards local changes irreversibly.',
    harm: 'local',
    binaries: ['git'],
  },
  {
    pattern: new RegExp(`${GIT}checkout(?:\\s+\\S+)*\\s+(?:--|\\.)(?:\\s|$)|${GIT}restore\\b(?:(?![^;|&\\n]*--staged)|[^;|&\\n]*--worktree)`),
    decision: 'gate',
    name: 'git-discard-changes',
    why: 'Discards uncommitted changes to tracked files.',
    harm: 'local',
    binaries: ['git'],
  },
  {
    pattern: new RegExp(`${GIT}clean\\b[^;|&\\n]*\\s(?:-[a-zA-Z]*f|--force)`),
    decision: 'gate',
    name: 'git-clean',
    why: 'Deletes untracked files.',
    harm: 'local',
    binaries: ['git'],
  },
  {
    pattern: /\bfind\b[^;|&\n]*\s-delete\b/,
    decision: 'gate',
    name: 'find-delete',
    why: 'Deletes every file the search matches.',
    harm: 'local',
    binaries: ['find'],
  },
  {
    pattern: /\brsync\b[^;|&\n]*\s--del(?:ete[\w-]*)?\b/,
    decision: 'gate',
    name: 'rsync-delete',
    why: 'Deletes destination files the source lacks.',
    harm: 'local',
    binaries: ['rsync'],
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
    pattern: new RegExp(`${GIT}push\\b[^;|&]*?(?:\\s--force\\b|\\s-f\\b)`),
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

/** Programs that run an argument as a program; under them, binary-scoped rules match the whole line. */
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

/** One quote-aware pass: programs in command position (after env assignments and prefix words) and the unquoted
 *  text. Over-collecting is safe. */
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

/** null: the shell would expand it. */
type ShellWord = string | null;

/** `after`: the separator before it, `;` for a newline or parenthesis. */
interface ShellStep {
  readonly after: string;
  readonly words: readonly ShellWord[];
}

const EXPANDING: ReadonlySet<string> = new Set(['$', '`', '*', '?', '[']);

const STEP_BREAKS: ReadonlySet<string> = new Set([';', '\n', '(', ')']);

/** A subshell's `cd` counts as the session's, which only asks more. */
function shellSteps(command: string): ShellStep[] {
  const steps: ShellStep[] = [];
  let words: ShellWord[] = [];
  let after = '';
  let word = '';
  let started = false;
  let expands = false;
  let quote: string | null = null;

  const endWord = () => {
    if (started) words.push(expands ? null : word);
    word = '';
    started = false;
    expands = false;
  };

  const endStep = (next: string) => {
    endWord();

    if (words.length > 0) steps.push({ after, words });
    words = [];
    after = next;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);

    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '$' || ch === '`')) { expands = true; word += ch; }
      else word += ch;
      continue;
    }

    const pair = command.slice(i, i + 2);

    if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (ch === '\\') { word += command.charAt(++i); started = true; }
    else if (ch === ' ' || ch === '\t') endWord();
    else if (pair === '&&' || pair === '||') { endStep(pair); i++; }
    else if (STEP_BREAKS.has(ch)) endStep(';');
    else if (ch === '|' || ch === '&') endStep(ch);
    else { word += ch; started = true; expands ||= EXPANDING.has(ch); }
  }

  endStep('');

  return steps;
}

function normalizedPath(path: string): string {
  const parts: string[] = [];

  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '' && part !== '.') parts.push(part);
  }

  return `/${parts.join('/')}`;
}

function shellPath(word: ShellWord, cwd: string, home: string): string | null {
  if (word === null) return null;

  if (word === '~' || word.startsWith('~/')) return normalizedPath(home + word.slice(1));

  if (word.startsWith('~')) return null;

  return normalizedPath(word.startsWith('/') ? word : `${cwd}/${word}`);
}

function underRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** null: unknown; `undefined`: not a `cd`. */
function cdTarget(step: ShellStep, cwd: string, home: string): string | null | undefined {
  const [verb, ...args] = step.words;

  if (verb === 'popd') return null;

  if (verb !== 'cd' && verb !== 'pushd') return undefined;
  const target = args.find((arg) => arg === null || arg === '-' || !arg.startsWith('-'));

  if (target === undefined) return verb === 'cd' ? home : null;

  return target === '-' ? null : shellPath(target, cwd, home);
}

/** Known when every step ran (`&&`, exit 0) or it ends on the `cd`; else a `cd` that may enter the user's files
 *  marks the session. `cd "$DIR"` moves nothing. */
function nextShellCwd(at: ShellCwd, command: string, exitCode: number, userRoots: readonly string[]): ShellCwd {
  const steps = shellSteps(command);
  let cwd = at.cwd;
  let known = true;
  let mayBeUsers = at.mayBeUsers;
  let lastCd = -1;

  for (const [index, step] of steps.entries()) {
    const target = cdTarget(step, cwd, at.home);

    if (target === undefined) continue;
    lastCd = index;

    if (target === null) {
      known = false;
      continue;
    }

    cwd = target;
    mayBeUsers ||= underRoots(target, userRoots);
  }

  if (lastCd === -1) return at;
  const allRan = steps.every((step, index) => index === 0 || step.after === '&&');
  const endsOnCd = lastCd === steps.length - 1 && ['', ';', '&&'].includes(steps[lastCd]?.after ?? '');

  if (exitCode === 0 && known && (allRan || endsOnCd)) return { ...at, cwd, mayBeUsers: underRoots(cwd, userRoots) };

  return { ...at, cwd, mayBeUsers };
}

function namesRoot(command: string, root: string): boolean {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return new RegExp(`(?<![\\w.~/-])${escaped}(?![\\w.-])`).test(command);
}

/** A call's session from its `cwd` option; an unresolvable one may be the user's. */
export function sessionAt(home: string, cwd: string | undefined): ShellCwd {
  const at = cwd === undefined ? home : shellPath(cwd, home, home);

  return at === null ? { cwd: home, home, mayBeUsers: true } : { cwd: at, home, mayBeUsers: false };
}

export function createShellSession({ home, userRoots, keepsCwd, stored }: ShellSessionOptions): ShellSession {
  const atHome: ShellCwd = { home, cwd: home, mayBeUsers: false };
  let known: ShellCwd | null = keepsCwd && stored !== undefined ? null : atHome;
  let tail: Promise<unknown> = Promise.resolve();

  return {
    home,
    userRoots,
    serial<R>(call: () => Promise<R>): Promise<R> {
      const next = tail.then(call, call);
      tail = next;

      return next;
    },
    async at() {
      if (known !== null) return known;
      const cwd = stored === undefined ? home : await stored();
      known = cwd === null ? { ...atHome, mayBeUsers: true } : sessionAt(home, cwd);

      return known;
    },
    ran(command, exitCode) {
      // Unread: the next review reads it.
      if (keepsCwd && known !== null) known = nextShellCwd(known, command, exitCode, userRoots());
    },
  };
}

/** The user's when the command names or reaches under one of their roots, or its session may be there. */
export function commandFilesOwner(executor: GatedExecutor, command: string, session: ShellCwd | undefined): FilesOwner {
  const roots = executor.shellSession?.userRoots() ?? [];

  if (executor.filesOwner === 'user' || roots.length === 0) return executor.filesOwner;

  if (roots.some((root) => namesRoot(command, root))) return 'user';

  if (session === undefined) return 'agent';

  if (session.mayBeUsers || underRoots(session.cwd, roots)) return 'user';
  let cwd = session.cwd;

  for (const step of shellSteps(command)) {
    const reached = step.words.map((word) => (word?.startsWith('-') ? null : shellPath(word, cwd, session.home)));

    if (reached.some((path) => path !== null && underRoots(path, roots))) return 'user';
    cwd = cdTarget(step, cwd, session.home) ?? cwd;
  }

  return 'agent';
}

/** A `mv` or `cp` destination: `-t`'s, else the last argument. */
function copyTarget(step: ShellStep): ShellWord | undefined {
  const [verb, ...args] = step.words;

  if (verb !== 'mv' && verb !== 'cp') return undefined;
  const flag = args.indexOf('-t');

  if (flag !== -1) return args[flag + 1];
  const long = args.find((arg) => arg?.startsWith('--target-directory=') === true);

  return long === undefined ? args.at(-1) : long?.slice('--target-directory='.length) ?? null;
}

function truncatingRedirect(word: string): number {
  for (let i = 0; i < word.length; i++) {
    if (word.charAt(i) === '>' && word.charAt(i - 1) !== '>' && word.charAt(i + 1) !== '>') return i;
  }

  return -1;
}

/** Files a `>` truncates; `>>` appends. */
function redirectTargets(step: ShellStep): ShellWord[] {
  const targets: ShellWord[] = [];

  for (const [index, word] of step.words.entries()) {
    const at = word === null ? -1 : truncatingRedirect(word);

    if (word === null || at === -1) continue;
    const rest = word.slice(at + 1);
    targets.push(rest === '' ? step.words[index + 1] ?? null : rest);
  }

  return targets;
}

function overwritesUserFiles(executor: GatedExecutor, command: string, session: ShellCwd | undefined): boolean {
  const roots = executor.shellSession?.userRoots() ?? [];
  const home = session?.home ?? '/';
  let cwd = session?.cwd ?? '/';

  for (const step of roots.length === 0 ? [] : shellSteps(command)) {
    const written = [...redirectTargets(step), copyTarget(step)].map((target) => (target === undefined ? null : shellPath(target, cwd, home)));

    if (written.some((path) => path !== null && underRoots(path, roots))) return true;
    cwd = cdTarget(step, cwd, home) ?? cwd;
  }

  return false;
}

const OVERWRITE: ApprovalRuleHit = {
  decision: 'gate', rule: 'overwrite-user-files', explanation: 'Moves, copies or writes onto the user\'s device or Drive, replacing what is there.',
};

/** The rule table for whose files a command reaches, and any overwrite onto the user's mounts. */
export function reviewShellCommand(executor: GatedExecutor, command: string, session: ShellCwd | undefined): ApprovalResult {
  const review = reviewCommand(command, commandFilesOwner(executor, command, session));

  if (!overwritesUserFiles(executor, command, session)) return review;
  const hits = [...review.hits, OVERWRITE];

  return { decision: dominant(hits), hits };
}

/** `runCode` in another language: its text cannot show what it does to the user's files, so it asks there. */
export function reviewProgram(code: string, filesOwner: FilesOwner): ApprovalResult {
  const review = reviewCommand(code, filesOwner);

  if (filesOwner === 'agent') return review;
  const hits = [...review.hits, { decision: 'gate', rule: 'program-on-user-files', explanation: 'Runs a program over the user\'s files.' } as const];

  return { decision: dominant(hits), hits };
}

/** No default owner: no caller silently picks a trust tier. */
export function reviewCommand(command: string, filesOwner: FilesOwner): ApprovalResult {
  const { invoked, unquoted } = scanCommand(command);
  let opaque = false;

  for (const binary of invoked) {
    if (INLINE_INTERPRETERS.has(binary)) { opaque = true; break; }
  }

  const agentsOwn = filesOwner === 'agent';

  const hits: ApprovalRuleHit[] = [];

  for (const r of RULES) {
    // Rules without binaries, and every rule under an interpreter, match the raw text.
    if (r.binaries && !opaque) {
      if (!r.binaries.some((b) => invoked.has(b))) continue;

      if (!r.pattern.test(unquoted)) continue;
    } else if (!r.pattern.test(command)) continue;

    // Local harm to the agent's own files is not gated; 'deny' is exempt.
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

const APPROVAL_DENIED = 'Denied';

/** Not imported from config/store.ts: a layergate subject source stays import-free. */
export type ShellApprovalMode = 'strict' | 'allow_all' | 'deny_all';

/** Read at call time, so a mode or channel change applies to the next command. */
export interface ShellApprovalPolicy {
  mode(): ShellApprovalMode;
  /** Whether the owner granted this rule on this executor; consulted before asking. */
  granted?(grant: ApprovalGrant): boolean;
  /** The 'gate' channel under 'strict', read live; null: nobody listens, so `deferrals`, else a refusal. */
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

/** Parks an unanswered 'gate' on the owner (safety/deferred-approval.ts). `run: true`: the grant is spent;
 *  `settle` refunds unrun attempts. */
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
 * The one gate for every boundary that reaches a shell. `denyResult` writes a refusal into the result; `refusalCode`
 * reads its classification back, and a proven not-run code refunds a spent grant.
 */
export interface ExecGateTuning<R> {
  readonly policy?: ShellApprovalPolicy;
  readonly refusalCode?: (result: R) => ErrorCode | null;
  /** Absent: a shell command from the executor's session. */
  readonly review?: (command: string, rest: readonly unknown[]) => Promise<ApprovalResult>;
}

export function gateExec<R>(
  execute: (command: string, ...rest: unknown[]) => Promise<R>,
  denyResult: (error: KinuError) => R,
  executor: GatedExecutor,
  tuning: ExecGateTuning<R> = {},
): (...args: unknown[]) => Promise<R> {
  const policy = tuning.policy ?? STRICT_NO_CHANNEL_POLICY;
  const refusalCode = tuning.refusalCode;

  // Rest args keep this assignable to `ExecutorProvider['tools'][name].execute` and to `Shell.exec`.
  return async (...args) => {
    const [command, ...rest] = args;
    const cmd = String(command);

    const review = tuning.review === undefined
      ? reviewShellCommand(executor, cmd, await executor.shellSession?.at())
      : await tuning.review(cmd, rest);

    const decision = await decideApproval({ command: cmd, executor: executor.name }, review, policy);

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

/** The mode/grant/channel/deferral ladder; a `run: true` from a replayed park carries a spend the caller settles. */
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
        // Under 'strict', an unanswered ask parks if a queue is wired, only after the channel declines.
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
 * A facet's policy: no `remember` or `requestApproval`, so it cannot widen its reach; `strict` with nothing
 * granted until the first resolve.
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
