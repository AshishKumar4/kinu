export const OAUTH_PROVIDER_ENV = {
  google: { label: 'Google', clientId: 'GOOGLE_OAUTH_CLIENT_ID', clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET' },
  github: { label: 'GitHub', clientId: 'GITHUB_OAUTH_CLIENT_ID', clientSecret: 'GITHUB_OAUTH_CLIENT_SECRET' },
  cloudflare: { label: 'Cloudflare', clientId: 'CLOUDFLARE_OAUTH_CLIENT_ID', clientSecret: 'CLOUDFLARE_OAUTH_CLIENT_SECRET' },
} as const;

export type OAuthProviderId = keyof typeof OAUTH_PROVIDER_ENV;

type ProviderEnvName = (typeof OAUTH_PROVIDER_ENV)[OAuthProviderId]['clientId' | 'clientSecret'];

export type OAuthProviderEnv = { [Name in ProviderEnvName]?: string } & {
  GOOGLE_OAUTH_SCOPES?: string;
  GITHUB_OAUTH_SCOPES?: string;
  CLOUDFLARE_OAUTH_SCOPES?: string;
  CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD?: string;
};

export interface SignInDeclarationEnv extends OAuthProviderEnv {
  SIGN_IN_PROVIDERS?: string;
}

export function builtinSignInOn(env: SignInDeclarationEnv): boolean {
  const declared = Object.values(OAUTH_PROVIDER_ENV).flatMap((names) => [env[names.clientId], env[names.clientSecret]]);

  return [...declared, env.SIGN_IN_PROVIDERS].every((value) => (value ?? '').trim() === '');
}
