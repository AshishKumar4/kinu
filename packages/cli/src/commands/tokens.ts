/**
 * `kinu tokens` — manage long-lived, scoped CI access tokens (`pta_…`).
 * Minting requires an interactive session signed in within the step-up
 * window, so a stale terminal gets pointed back at `kinu auth`.
 */
import {
  createCliAccessToken,
  listCliAccessTokens,
  revokeCliAccessToken,
} from '../cloud-api';
import { requireAuthConfig } from '../config';
import { ACCENT, DIM, OK, WARN } from '../display';

export interface TokensOpts {
  name?: string;
  scopes?: string;
  json?: boolean;
}

export async function tokensCommand(action: string | undefined, name: string | undefined, opts: TokensOpts): Promise<void> {
  const sub = action ?? 'list';
  if (sub === 'list') return listTokens(opts);
  if (sub === 'create') return createToken(name, opts);
  if (sub === 'revoke') return revokeToken(name ?? opts.name);
  throw new Error('Usage: kinu tokens [list | create --name <name> --scopes <scopes> | revoke <name>]');
}

async function listTokens(opts: TokensOpts): Promise<void> {
  const auth = requireAuthConfig();
  const { tokens } = await listCliAccessTokens(auth.origin, auth.token);
  if (opts.json) {
    console.log(JSON.stringify(tokens, null, 2));
    return;
  }
  if (tokens.length === 0) {
    console.log(DIM('No access tokens. Create one with: kinu tokens create --name ci --scopes workspace.exec,workspace.read'));
    return;
  }
  for (const token of tokens) {
    console.log(`${ACCENT(token.name)}  ${DIM(token.scopes.join(', '))}`);
    console.log(`  ${DIM('created')} ${formatWhen(token.createdAt)}  ${DIM('last used')} ${token.lastUsedAt ? formatWhen(token.lastUsedAt) : 'never'}`);
  }
}

async function createToken(positionalName: string | undefined, opts: TokensOpts): Promise<void> {
  const name = opts.name ?? positionalName;
  if (!name) throw new Error('Token name required: kinu tokens create --name ci --scopes workspace.exec,workspace.read');
  const scopes = (opts.scopes ?? '').split(/[\s,]+/).filter(Boolean);
  if (scopes.length === 0) throw new Error('Scopes required: --scopes workspace.exec,workspace.read');

  const auth = requireAuthConfig();
  const created = await createCliAccessToken(auth.origin, auth.token, { name, scopes });
  if (opts.json) {
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  console.log(`${OK('✓')} Access token ${ACCENT(created.name)} created with scopes: ${created.scopes.join(', ')}`);
  console.log('');
  console.log(`  ${created.token}`);
  console.log('');
  console.log(WARN('This token is shown once — store it as a CI secret now.'));
  console.log(DIM('Use it headlessly:'));
  console.log(DIM(`  KINU_TOKEN=${created.token.slice(0, 12)}… kinu exec --workspace <name> --json "task"`));
}

async function revokeToken(ref: string | undefined): Promise<void> {
  if (!ref) throw new Error('Token name required: kinu tokens revoke <name>');
  const auth = requireAuthConfig();
  await revokeCliAccessToken(auth.origin, auth.token, ref);
  console.log(`${OK('✓')} Access token ${ACCENT(ref)} revoked`);
}

function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
