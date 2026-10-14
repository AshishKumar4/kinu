/**
 * The Cloudflare REST tokens, read from the environment and nothing else: no import, so a config file loaded by Node
 * itself (packages/cf-backend/vitest.config.ts, through tests/helpers/workers-ai-binding.ts) can read one.
 */

/**
 * The deploy's Cloudflare REST token. KINU_CLOUDFLARE_API_TOKEN first, ON PURPOSE: wrangler honours both generic
 * names (CLOUDFLARE_API_TOKEN and CF_API_TOKEN), so a REST token exported under either hijacks every wrangler
 * subcommand the deploy also runs (measured: `wrangler vectorize list` refusing under an Access-only token). A name
 * wrangler never reads keeps the deploy's OAuth login serving wrangler.
 */
export function restApiToken(): string {
  return (process.env['KINU_CLOUDFLARE_API_TOKEN'] ?? process.env['CLOUDFLARE_API_TOKEN'] ?? process.env['CF_API_TOKEN'] ?? '').trim();
}

/** The token the container registry's snapshots are deleted with: DEVBOX_REGISTRY_TOKEN, scoped to the registry,
 *  else the deploy's REST token. */
export function registryToken(): string {
  const registry = process.env['DEVBOX_REGISTRY_TOKEN']?.trim();

  return registry === undefined || registry === '' ? restApiToken() : registry;
}
