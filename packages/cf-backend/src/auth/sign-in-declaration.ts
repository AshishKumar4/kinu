/** OAuth or built-in, from what the deployment declares. No runtime imports: the session store reads it. */
import type { OAuthProviderEnv } from './providers';

const OAUTH_ENV_NAMES = [
  'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET',
  'CLOUDFLARE_OAUTH_CLIENT_ID', 'CLOUDFLARE_OAUTH_CLIENT_SECRET',
] as const satisfies readonly (keyof OAuthProviderEnv)[];

export interface SignInDeclarationEnv extends OAuthProviderEnv {
  SIGN_IN_PROVIDERS?: string;
}

/** A broken provider leaves sign-in unavailable: a lost secret never opens built-in sign-in. */
export function builtinSignInOn(env: SignInDeclarationEnv): boolean {
  return [...OAUTH_ENV_NAMES.map((name) => env[name]), env.SIGN_IN_PROVIDERS].every((value) => (value ?? '').trim() === '');
}
