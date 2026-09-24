// An account is a stored key `<base>@<name>`; the bare key is `main`.
import { KinuError } from '../obs/index';

export const MAIN_ACCOUNT = 'main';

const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const PROVIDER_SCOPE_RE = /^[a-z0-9][a-z0-9._:-]*$/;

/** Cloudflare's login also runs AI Gateway. */
const SINGLE_ACCOUNT_KEY_PREFIX = 'cloudflare.';

export function isAccountName(name: string): boolean {
  return ACCOUNT_NAME_RE.test(name);
}

/** A provider a workspace's account choice is kept under. */
export function isProviderScope(provider: string): boolean {
  return PROVIDER_SCOPE_RE.test(provider);
}

/** The only `@` split of a key or a spec's provider. */
export function splitAccount(value: string): { readonly base: string; readonly account: string | null } {
  const at = value.indexOf('@');

  return at === -1
    ? { base: value, account: null }
    : { base: value.slice(0, at), account: value.slice(at + 1) };
}

export function baseCredentialKey(key: string): string {
  return splitAccount(key).base;
}

export function accountOf(key: string): string {
  return splitAccount(key).account ?? MAIN_ACCOUNT;
}

function acceptsAccounts(baseKey: string): boolean {
  return !baseKey.startsWith(SINGLE_ACCOUNT_KEY_PREFIX);
}

export function accountCredentialKey(baseKey: string, account: string): string {
  if (baseCredentialKey(baseKey) !== baseKey) {
    throw new KinuError('bad_input', `${baseKey} already names an account.`);
  }

  if (account === MAIN_ACCOUNT) return baseKey;

  if (!isAccountName(account)) {
    throw new KinuError('bad_input',
      `"${account}" is not an account name: use a-z, 0-9 and dashes, up to 32 characters, starting with a letter or digit.`);
  }

  if (!acceptsAccounts(baseKey)) {
    throw new KinuError('bad_input', `${baseKey} has one account: Cloudflare is one sign-in.`);
  }

  return `${baseKey}@${account}`;
}

export function storedAccounts(baseKey: string, keys: readonly string[]): string[] {
  const accounts = keys.filter((key) => baseCredentialKey(key) === baseKey).map(accountOf);
  const named = accounts.filter((account) => account !== MAIN_ACCOUNT).sort();

  return accounts.length > named.length ? [MAIN_ACCOUNT, ...named] : named;
}
