import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import * as oauth from 'oauth4webapi';
import { CLOUDFLARE_WORKERS_AI_SCOPES } from '@kinu.run/core';

import { OAUTH_PROVIDER_ENV, type OAuthProviderEnv, type OAuthProviderId } from '@kinu.run/core/identity';

export type { OAuthProviderEnv, OAuthProviderId };

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

const discoveryCache = new Map<string, { as: oauth.AuthorizationServer; expiresAt: number }>();

const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export function listConfiguredOAuthProviders(env: OAuthProviderEnv): PublicOAuthProvider[] {
  return getConfiguredOAuthProviders(env).map(({ id, label }) => ({ id, label }));
}

function getConfiguredOAuthProviders(env: OAuthProviderEnv): OAuthProviderConfig[] {
  const out: OAuthProviderConfig[] = [];

  const google = providerFromEnv(env, 'google');

  if (google) {
    out.push({
      ...google,
      kind: 'oidc',
      scopes: cleanScopes(env.GOOGLE_OAUTH_SCOPES, 'openid email profile'),
      issuer: 'https://accounts.google.com',
      tokenAuthMethod: 'client_secret_post',
    });
  }

  const github = providerFromEnv(env, 'github');

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

  const cloudflare = providerFromEnv(env, 'cloudflare');

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

export function getAuthorizationServer(provider: OAuthProviderConfig): Promise<oauth.AuthorizationServer> {
  return settle(Effect.gen(function* () {
    if (provider.authorizationServer) return provider.authorizationServer;

    if (!provider.issuer) return yield* Effect.die(new Error(`Provider ${provider.id} has no issuer.`));
    const cached = discoveryCache.get(provider.issuer);

    if (cached && cached.expiresAt > Date.now()) return cached.as;

    const issuer = new URL(provider.issuer);
    const response = yield* Effect.promise(async () => oauth.discoveryRequest(issuer, { algorithm: 'oidc' }));
    const as = yield* Effect.promise(async () => oauth.processDiscoveryResponse(issuer, response));
    discoveryCache.set(provider.issuer, { as, expiresAt: Date.now() + DISCOVERY_TTL_MS });

    return as;
  }));
}

export function clientAuth(provider: OAuthProviderConfig): oauth.ClientAuth {
  return provider.tokenAuthMethod === 'client_secret_basic'
    ? oauth.ClientSecretBasic(provider.clientSecret)
    : oauth.ClientSecretPost(provider.clientSecret);
}

function providerFromEnv(env: OAuthProviderEnv, id: OAuthProviderId): Pick<OAuthProviderConfig, 'id' | 'label' | 'clientId' | 'clientSecret'> | null {
  const names = OAUTH_PROVIDER_ENV[id];
  const clientId = cleanEnv(env[names.clientId]);
  const clientSecret = cleanEnv(env[names.clientSecret]);

  if (!clientId || !clientSecret) return null;

  return { id, label: names.label, clientId, clientSecret };
}

function cleanEnv(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';

  // An env var set to whitespace is a provider nobody configured, not a secret.
  return trimmed === '' ? null : trimmed;
}

function cleanScopes(value: string | undefined, fallback: string): string {
  const scopes = (value ?? fallback).trim().split(/\s+/).filter(Boolean);

  return scopes.length ? scopes.join(' ') : fallback;
}
