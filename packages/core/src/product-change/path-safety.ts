export interface ProductPathValidation {
  ok: boolean;
  path?: string;
  error?: string;
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

export function normalizeProductSourcePath(rawPath: string): string {
  const raw = rawPath.replace(/\\/g, '/').trim();
  if (!raw) throw new Error('product path is empty');
  if (/^[A-Za-z]:\//.test(raw) || raw.startsWith('/')) {
    throw new Error(`product path "${rawPath}" must be repo-relative, not absolute`);
  }

  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw new Error(`product path "${rawPath}" escapes outside the source root`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) throw new Error('product path resolves to repository root');
  return parts.join('/');
}

export function validateProductPatchPath(rawPath: string): ProductPathValidation {
  let path: string;
  try {
    path = normalizeProductSourcePath(rawPath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  for (const pattern of SECRET_PATH_PATTERNS) {
    if (pattern.test(path)) return { ok: false, path, error: `secret/config path is not patchable: ${path}` };
  }
  return { ok: true, path };
}

export function redactProductDiff(diff: string): string {
  return diff.split('\n').map((line) => {
    if (!/^[+-]/.test(line) || line.startsWith('+++') || line.startsWith('---')) return line;
    if (SECRET_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      return `${line[0]}[redacted sensitive diff line]`;
    }
    return line;
  }).join('\n');
}

export function isSecretProductPath(rawPath: string): boolean {
  const normalized = validateProductPatchPath(rawPath);
  return !normalized.ok && /secret|config/.test(normalized.error ?? '');
}
