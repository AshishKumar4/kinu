/**
 * Secrets in text the owner is about to send or store: a chat draft (offered a move into the account's secrets before
 * it leaves the browser) and a pasted `.env` file. Known shapes only (`secret-patterns.ts`): a bare random key with no
 * provider prefix and no telling name is not recognised.
 */

import { CREDENTIALED_URL, credentialValueScanners, secretProvider } from './secret-patterns';
import { EGRESS_PLACEHOLDER_PREFIX, type SecretPosition } from './egress-gate';

interface DotenvEntry {
  readonly name: string;
  readonly value: string;
}

/** A secret found in a draft, and what to offer it as. */
export interface PastedSecret {
  readonly value: string;
  /** The variable it was assigned to, else its provider's own variable, else `SECRET`; unique within one draft. */
  readonly name: string;
  /** Its provider's hosts; none where no shape names a provider. */
  readonly hosts: readonly string[];
  /** Whose credential it looks like, where a shape says: "GitHub". */
  readonly provider: string | null;
  /** Where its provider's API reads it; the Authorization header where no shape says. */
  readonly position: SecretPosition;
}

/** A line's assignment: `export` dropped, the name, then the value's text to the end of the text. */
const DOTENV_NAME = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/u;

/** A quoted value as dotenv reads it: from its opening quote to the next one no backslash escapes, across lines; in
 *  double quotes `\n` and `\r` are a line break. Null where it never closes. */
function quotedValue(text: string, quote: string): { value: string; length: number } | null {
  for (let at = 1; at < text.length; at++) {
    if (text[at] === '\\') at += 1;
    else if (text[at] === quote) {
      const inner = text.slice(1, at);

      return { value: quote === '"' ? inner.replaceAll('\\n', '\n').replaceAll('\\r', '\r') : inner, length: at + 1 };
    }
  }

  return null;
}

/**
 * `NAME=value` lines as dotenv reads them: `export` dropped, a `#` line skipped. A value opening with a quote runs to
 * its closing quote (one a backslash escapes does not close it), `#` and line breaks included, and what follows it is a
 * comment; an unquoted one ends at ` #`.
 */
export function parseDotenv(text: string): DotenvEntry[] {
  const entries: DotenvEntry[] = [];
  let rest = text;

  while (rest !== '') {
    const lineEnd = rest.search(/\r?\n/u);
    const line = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
    const assignment = line.trimStart().startsWith('#') ? null : DOTENV_NAME.exec(line);
    let consumed = lineEnd === -1 ? rest.length : lineEnd + (rest[lineEnd] === '\r' ? 2 : 1);

    if (assignment !== null) {
      const name = assignment[1] ?? '';
      const raw = rest.slice(assignment[0].length);
      const quote = /^["'`]/u.exec(raw)?.[0];
      const quoted = quote === undefined ? null : quotedValue(raw, quote);

      if (quoted !== null) {
        // The rest of the closing line is a comment.
        const after = raw.slice(quoted.length).search(/\r?\n/u);

        consumed = after === -1 ? rest.length : assignment[0].length + quoted.length + after + (raw[quoted.length + after] === '\r' ? 2 : 1);

        if (quoted.value !== '') entries.push({ name, value: quoted.value });
      } else {
        const value = line.slice(assignment[0].length).replace(/\s+#.*$/u, '').trim();

        if (value !== '') entries.push({ name, value: quote === undefined ? value : value.slice(1) });
      }
    }

    rest = rest.slice(consumed);
  }

  return entries;
}

/** A variable whose name says it holds a credential. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** A blank for the reader to fill (`<your-key>`), or the vault's own stand-in, which is no secret. */
function isBenign(value: string): boolean {
  return /<your-|placeholder/i.test(value) || value.startsWith(EGRESS_PLACEHOLDER_PREFIX);
}

/** Each secret in `text`: a `NAME=value` line whose name or value says so, a private key block, a provider-shaped value. */
export function pastedSecrets(text: string): PastedSecret[] {
  const found: { value: string; name: string | null }[] = [];
  const seen = new Set<string>();

  const add = (value: string, name: string | null): void => {
    if (seen.has(value) || isBenign(value)) return;
    seen.add(value);
    found.push({ value, name });
  };

  for (const { name, value } of parseDotenv(text)) {
    if (SECRET_NAME.test(name) || new RegExp(CREDENTIALED_URL.source).test(value) || credentialValueScanners().some((scanner) => scanner.test(value))) add(value, name);
  }

  for (const block of text.matchAll(PRIVATE_KEY_BLOCK)) add(block[0], 'PRIVATE_KEY');

  for (const scanner of credentialValueScanners()) {
    for (const match of text.matchAll(scanner)) add(match[0], null);
  }

  const names = new Set<string>();

  return found.map(({ value, name }) => {
    const provider = secretProvider(value);
    const base = name ?? provider?.variable ?? 'SECRET';
    let unique = base;

    for (let n = 2; names.has(unique); n++) unique = `${base}_${String(n)}`;
    names.add(unique);

    return { value, name: unique, hosts: provider?.hosts ?? [], provider: provider?.name ?? null, position: provider?.position ?? { kind: 'authorization' } };
  });
}
