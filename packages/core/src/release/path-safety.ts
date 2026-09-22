
import { renderThrownChain } from '../obs/index';

export interface ReleasePathValidation {
  ok: boolean;
  path?: string;
  error?: string;
  /** Carried as a field so `isSecretReleasePath` never parses the human-readable `error`. */
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
  // Both spellings: this repository's manifests are `wrangler.jsonc`.
  /(^|\/)wrangler\.(?:toml|jsonc?)$/i,
  // Hooks under `.git` run on the next git command with the release step's authority.
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

/** Refuses the whole diff's path set (git apply writes many files at once); `--- a/` is read because a
 *  pure deletion names its victim only there. A diff declaring no file is refused. */
export function validateReleasePatchTargets(diff: string): string | null {
  const refusals: string[] = [];
  let declared = 0;

  for (const line of diff.split('\n')) {
    const header = /^(?:\+\+\+|---) (.+)$/.exec(line);

    if (!header) continue;
    // Some dialects append a tab-separated timestamp.
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

/** Exact hostnames: `github.com.attacker.example` ends with the string and is not GitHub. */
const GITHUB_HOSTS: readonly string[] = ['github.com', 'www.github.com'];

/** A GitHub credential is installed as an auth header before cloning this URL, so require https,
 *  no userinfo, and a GitHub host. Throws with the reason. */
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
