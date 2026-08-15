import * as oauth from 'oauth4webapi';
import { CLOUDFLARE_WORKERS_AI_SCOPES } from '../lib/cloudflare-oauth.js';

export type OAuthProviderId = 'google' | 'github' | 'cloudflare';

export interface PublicOAuthProvider {
  id: OAuthProviderId;
  label: string;
}

export interface OAuthProviderConfig extends PublicOAuthProvider {
  kind: 'oidc' | 'oauth';
  clientId: string;
  clientSecret: string;
  scopes: string;
  issuer?: string;
  authorizationServer?: oauth.AuthorizationServer;
  tokenAuthMethod: 'client_secret_post' | 'client_secret_basic';
}

export interface OAuthProviderEnv {
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_SCOPES?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_SCOPES?: string;
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  CLOUDFLARE_OAUTH_SCOPES?: string;
  CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD?: string;
}

const providerLabels = {
  google: 'Google',
  github: 'GitHub',
  cloudflare: 'Cloudflare',
} satisfies Record<OAuthProviderId, string>;

const discoveryCache = new Map<string, { as: oauth.AuthorizationServer; expiresAt: number }>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export function listConfiguredOAuthProviders(env: OAuthProviderEnv): PublicOAuthProvider[] {
  return getConfiguredOAuthProviders(env).map(({ id, label }) => ({ id, label }));
}

export function getConfiguredOAuthProviders(env: OAuthProviderEnv): OAuthProviderConfig[] {
  const out: OAuthProviderConfig[] = [];

  const google = providerFromEnv(env, 'google', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET');
  if (google) {
    out.push({
      ...google,
      kind: 'oidc',
      scopes: cleanScopes(env.GOOGLE_OAUTH_SCOPES, 'openid email profile'),
      issuer: 'https://accounts.google.com',
      tokenAuthMethod: 'client_secret_post',
    });
  }

  const github = providerFromEnv(env, 'github', 'GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET');
  if (github) {
    out.push({
      ...github,
      kind: 'oauth',
      scopes: cleanScopes(env.GITHUB_OAUTH_SCOPES, 'read:user user:email'),
      authorizationServer: {
        issuer: 'https://github.com',
        authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://github.com/login/oauth/access_token',
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      },
      tokenAuthMethod: 'client_secret_post',
    });
  }

  const cloudflare = providerFromEnv(env, 'cloudflare', 'CLOUDFLARE_OAUTH_CLIENT_ID', 'CLOUDFLARE_OAUTH_CLIENT_SECRET');
  if (cloudflare) {
    out.push({
      ...cloudflare,
      kind: 'oauth',
      scopes: cleanScopes(env.CLOUDFLARE_OAUTH_SCOPES, CLOUDFLARE_WORKERS_AI_SCOPES),
      issuer: 'https://dash.cloudflare.com',
      tokenAuthMethod: env.CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD === 'client_secret_post'
        ? 'client_secret_post'
        : 'client_secret_basic',
    });
  }

  return out;
}

export function getOAuthProvider(env: OAuthProviderEnv, id: string): OAuthProviderConfig | null {
  return getConfiguredOAuthProviders(env).find((p) => p.id === id) ?? null;
}

export async function getAuthorizationServer(provider: OAuthProviderConfig): Promise<oauth.AuthorizationServer> {
  if (provider.authorizationServer) return provider.authorizationServer;
  if (!provider.issuer) throw new Error(`Provider ${provider.id} has no issuer.`);
  const cached = discoveryCache.get(provider.issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.as;

  const issuer = new URL(provider.issuer);
  const response = await oauth.discoveryRequest(issuer, { algorithm: 'oidc' });
  const as = await oauth.processDiscoveryResponse(issuer, response);
  discoveryCache.set(provider.issuer, { as, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return as;
}

export function clientAuth(provider: OAuthProviderConfig): oauth.ClientAuth {
  return provider.tokenAuthMethod === 'client_secret_basic'
    ? oauth.ClientSecretBasic(provider.clientSecret)
    : oauth.ClientSecretPost(provider.clientSecret);
}

function providerFromEnv(
  env: OAuthProviderEnv,
  id: OAuthProviderId,
  clientIdKey: keyof OAuthProviderEnv,
  clientSecretKey: keyof OAuthProviderEnv,
): Pick<OAuthProviderConfig, 'id' | 'label' | 'clientId' | 'clientSecret'> | null {
  const clientId = cleanEnv(env[clientIdKey]);
  const clientSecret = cleanEnv(env[clientSecretKey]);
  if (!clientId || !clientSecret) return null;
  return { id, label: providerLabels[id], clientId, clientSecret };
}

function cleanEnv(value: string | undefined): string | null {
  return value?.trim() || null;
}

function cleanScopes(value: string | undefined, fallback: string): string {
  const scopes = (value ?? fallback).trim().split(/\s+/).filter(Boolean);
  return scopes.length ? scopes.join(' ') : fallback;
}
