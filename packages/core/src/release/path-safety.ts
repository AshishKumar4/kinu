
import { renderThrownChain } from '../obs/index';
export interface ReleasePathValidation {
  ok: boolean;
  path?: string;
  error?: string;
  /** The rejection was a secret/config path rather than a traversal or an
   *  absolute path. Carried as a field because `isSecretReleasePath` used to
   *  recover it by running /secret|config/ over this record's human-readable
   *  `error`, which made rewording that sentence silently change the predicate. */
  secret?: boolean;
}

const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.dev\.vars$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)credentials(?:\.json)?$/i,
  // Both spellings. This list matched only `wrangler.toml`, and every manifest
  // in this repository — the one carrying the account id, the routes and the
  // binding set — is `wrangler.jsonc`, so the rule named a file that is not here.
  /(^|\/)wrangler\.(?:toml|jsonc?)$/i,
  // A patch that writes into `.git` is not a code change: hooks there run on
  // the next git command, with whatever authority the release step holds.
  /(^|\/)\.git(\/|$)/i,
];

const SECRET_LINE_PATTERNS: RegExp[] = [
  /(api[_-]?key|access[_-]?token|auth[_-]?token|(?:^|[_-])token|client[_-]?secret|password|private[_-]?key)\s*=/i,
  /(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
];

export function normalizeReleasePath(rawPath: string): string {
  const raw = rawPath.replace(/\\/g, '/').trim();
  if (!raw) throw new Error('release path is empty');
  if (/^[A-Za-z]:\//.test(raw) || raw.startsWith('/')) {
    throw new Error(`release path "${rawPath}" must be repo-relative, not absolute`);
  }

  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw new Error(`release path "${rawPath}" escapes outside the source root`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) throw new Error('release path resolves to repository root');
  return parts.join('/');
}

export function validateReleasePatchPath(rawPath: string): ReleasePathValidation {
  let path: string;
  try {
    path = normalizeReleasePath(rawPath);
  } catch (err) {
    return { ok: false, error: renderThrownChain({ cause: err }) };
  }
  if (SECRET_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
    return { ok: false, path, secret: true, error: `secret/config path is not patchable: ${path}` };
  }
  return { ok: true, path };
}

/**
 * Every path a unified diff would touch, refused as a SET. Null when the whole
 * diff is allowed; otherwise the reason, naming each refused path.
 *
 * A set rather than a path at a time, because a patch is not partially
 * applicable: `git apply` is handed one file and writes many, so the authority
 * has to be spent over the whole diff before any of it lands.
 *
 * `+++ b/<path>` is the write target and `--- a/<path>` is read as well, because
 * a pure deletion names its victim only there. `/dev/null` is neither. A diff
 * that declares no file at all is refused rather than passed: "validated
 * nothing" must not read as "found nothing wrong".
 */
export function validateReleasePatchTargets(diff: string): string | null {
  const refusals: string[] = [];
  let declared = 0;
  for (const line of diff.split('\n')) {
    const header = /^(?:\+\+\+|---) (.+)$/.exec(line);
    if (!header) continue;
    // `git diff` writes `+++ b/path`, and appends a tab-separated timestamp in
    // some dialects. Both are stripped before the path is judged.
    const raw = header[1].replace(/\t.*$/, '').trim().replace(/^[ab]\//, '');
    if (!raw || raw === '/dev/null') continue;
    declared += 1;
    const verdict = validateReleasePatchPath(raw);
    if (!verdict.ok && verdict.error !== undefined) refusals.push(verdict.error);
  }
  if (declared === 0) return 'patch declares no file to change — it is not a unified diff';
  if (refusals.length === 0) return null;
  return `patch touches paths a release may not write:\n${[...new Set(refusals)].join('\n')}`;
}

/** Hosts a `kind: 'github'` binding may name. Exact hostnames, not a suffix
 *  match: `github.com.attacker.example` ends with the string and is not GitHub. */
const GITHUB_HOSTS: readonly string[] = ['github.com', 'www.github.com'];

/**
 * Refuse a `kind: 'github'` repository URL that would send a GitHub credential
 * somewhere that is not GitHub. Throws with the reason; returns nothing.
 *
 * The release engine resolves ONE ambient credential for the binding's kind and
 * installs it as an HTTP authorization header before cloning this URL, so the
 * URL is the destination of a secret rather than merely the location of some
 * code. `https` only, because the header is the credential and a plaintext hop
 * publishes it; no userinfo, because `https://x:y@github.com/...` puts a second
 * credential in the ledger and a `@` also relocates the host for naive readers.
 */
export function assertGithubRepoUrl(rawUrl: string): void {
  const url = URL.parse(rawUrl.trim());
  if (!url) throw new Error(`github source binding repoUrl is not a URL: ${rawUrl}`);
  if (url.protocol !== 'https:') {
    throw new Error(`github source binding repoUrl must be https, got ${url.protocol.replace(':', '')}`);
  }
  if (url.username || url.password) {
    throw new Error('github source binding repoUrl must not carry credentials in the URL');
  }
  if (!GITHUB_HOSTS.includes(url.hostname.toLowerCase())) {
    throw new Error(
      `github source binding repoUrl must be on github.com, got ${url.hostname} — `
      + 'a github credential is installed before this URL is cloned',
    );
  }
}

export function redactReleaseDiff(diff: string): string {
  return diff.split('\n').map((line) => {
    if (!/^[+-]/.test(line) || line.startsWith('+++') || line.startsWith('---')) return line;
    if (SECRET_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      return `${line[0]}[redacted sensitive diff line]`;
    }
    return line;
  }).join('\n');
}

export function isSecretReleasePath(rawPath: string): boolean {
  return validateReleasePatchPath(rawPath).secret === true;
}
