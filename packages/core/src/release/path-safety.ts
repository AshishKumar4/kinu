
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
  /(^|\/)wrangler\.toml$/i,
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
