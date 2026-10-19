/**
 * Secrets in text the owner is about to send or store: a chat draft (offered a move into the account's secrets before
 * it leaves the browser) and a pasted `.env` file. Known shapes only (`secret-patterns.ts`): a bare random key with no
 * provider prefix and no telling name is not recognised.
 */

import { CREDENTIALED_URL, credentialValueScanners, secretProvider } from './secret-patterns';
import type { SecretPosition } from './egress-gate';

export interface DotenvEntry {
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

const DOTENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/**
 * `NAME=value` lines as dotenv reads them: `export` dropped, a `#` line skipped. A value opening with a quote runs to
 * its closing quote, `#` included, and what follows it is a comment; an unquoted one ends at ` #`.
 */
export function parseDotenv(text: string): DotenvEntry[] {
  const entries: DotenvEntry[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = DOTENV_LINE.exec(line);

    if (match === null || line.trimStart().startsWith('#')) continue;
    const [, name = '', raw = ''] = match;
    const quote = raw.startsWith('"') || raw.startsWith("'") ? raw.charAt(0) : null;
    const closing = quote === null ? -1 : raw.indexOf(quote, 1);
    const value = quote === null ? raw.replace(/\s+#.*$/, '') : raw.slice(1, closing === -1 ? undefined : closing);

    if (value !== '') entries.push({ name, value });
  }

  return entries;
}

/** A variable whose name says it holds a credential. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** A blank for the reader to fill (`<your-key>`), or the vault's own stand-in, which is no secret. */
function isBenign(value: string): boolean {
  return /<your-|placeholder/i.test(value) || value.startsWith('pxs1_');
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
