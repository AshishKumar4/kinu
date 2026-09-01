# Self-hosting

kinu.run is one deployment of this repository. A self-host uses the same Worker,
containers, and search code. Hosted language runtimes are separate artifacts in
`NIMBUS_RUNTIME_CACHE`; this repository does not yet include a reproducible
catalog seed command for a fresh account.

This is the path from an empty account to your own instance.
[docs/DEPLOYMENT.md](DEPLOYMENT.md) is the reference.

## One click is step zero

The landing page carries a Deploy to Cloudflare button pointing at
`https://deploy.workers.cloudflare.com/?url=https://github.com/AshishKumar4/kinu`.
That flow forks the repository into your GitHub account and starts a Workers
Build from the fork. That is all it can do, and it has not been rehearsed
against a fresh account. It cannot:

- put your account on the Workers Paid plan. SQLite Durable Objects,
  Containers and Worker Loaders are plan-gated.
- hold a zone, or create the proxied DNS records that previews and a staging
  route need. wrangler has no DNS command at all.
- create the KV namespaces. KV titles are not unique, so provisioning refuses
  to create them, and their ids are pasted into
  `packages/cf-backend/wrangler.jsonc` by hand.
- create an AI Gateway. No wrangler command can; you make one in the dashboard.
- seed the Nimbus runtime catalog. Creating its R2 bucket does not upload
  `catalog/v1.json`, manifests, or runtime blobs.
- mint the root secret, `CREDENTIAL_ENCRYPTION_KEY`. A key the program invents
  and never shows anyone is a key nobody can restore from, so it is a prompt at
  a terminal, displayed exactly once.
- register the OAuth applications sign-in needs. Those are created at Google,
  GitHub and Cloudflare, on their websites.

Treat the button as a fork with intent. The supported path is the three steps
below, run from a checkout of that fork.

## Step one: bring the account

Prerequisites nothing here can create for you:

- a Cloudflare account on the Workers Paid plan;
- a zone for the app hostname, active on that account;
- a wrangler login (`npx wrangler login`) with Workers, KV, R2, Vectorize,
  Containers and Email scopes.

Then name your deployment. Every value lives in
`packages/cf-backend/wrangler.jsonc`: your `account_id`, your `routes`, your
`CLI_PUBLIC_ORIGIN`, and the two KV namespace ids after
`wrangler kv namespace create` prints them. `scripts/deploy.sh` reads the
deploy account from `CLOUDFLARE_ACCOUNT_ID`, which defaults to the kinu.run
account, so export your own. Commit the configuration: the deploy refuses a
dirty checkout, so the build stamp always names the exact bytes that shipped.

The full prerequisite table, with the reason nothing here can create each item
and the command that re-checks it, is in
[docs/DEPLOYMENT.md](DEPLOYMENT.md#before-you-start). `bun run infra:provision`
prints the same worklist on every run.

## Step two: provision, deploy, provision

```bash
bun run infra:provision      # the R2 buckets and the Vectorize indexes
bun run deploy               # the Worker, its DO namespaces, container, routes, cron
bun run infra:provision      # the secrets; `wrangler secret put` needs the Worker to exist
```

Provisioning runs twice because `wrangler secret put` refuses on a Worker that
does not exist yet. The first run says so; the second creates nothing the first
created. `bun run deploy` runs 62 required gate invocations before deployment.
Preflight runs first, 58 gates run concurrently, and the three that need the
machine or the account to themselves — `gate:hammer`, `gate:infra`,
`gate:devbox-e2e` — run alone at the end, in that order. A
failed gate exits before Wrangler runs.

The fresh deployment does not have hosted Python, Bash, Ruby, or Clang until an
operator supplies a Nimbus runtime catalog. The base workspace and the
Cloudflare container remain available. Do not advertise runtime parity for a
fresh self-host until a seed command and content check exist.

## Step three: prove the account

```bash
bun run gate:infra
```

The gate checks that every resource `wrangler.jsonc` declares exists and that
the deployed Worker is bound to it, one verdict per resource, and exits
non-zero on any failure. What no CLI can observe is declared with its manual
check instead of skipped; `scripts/infra-verify.ts` carries the reasoning.

## Sign-in

A provider appears on `/login` only when both its client id and its client
secret are configured. Register your own OAuth application at each provider
you want, with the redirect URL:

```text
https://<your-host>/auth/<provider>/callback
```

Client ids are plain vars in `wrangler.jsonc`; client secrets are Wrangler
secrets, and the second provisioning run prompts for them. The Cloudflare
provider is the one worth having: signing in with it also connects the user's
own Workers AI, so their chat bills their account rather than yours. The exact
scopes and grant types are in [docs/DEPLOYMENT.md](DEPLOYMENT.md#oauth-setup).

## What works when

Each surface stays off until its owner step is done, and absence means "off",
not an error.

| Surface | Works after |
| --- | --- |
| Public pages, install script, CLI downloads | the first deploy |
| Signed-in surfaces (web, CLI, credentials) | the root secret is installed |
| Sign-in | you register at least one OAuth application |
| Chat billed to the platform account | the AI Gateway exists and `AI_GATEWAY_URL` names it |
| Chat billed to each user's account | the Cloudflare OAuth application and its secret |
| Previews | a proxied wildcard DNS record under `PREVIEW_HOST_SUFFIX` |
| Email to workspaces | Email Routing onboarding; [docs/EMAIL-INGRESS.md](EMAIL-INGRESS.md) |
| Fleet metrics on the control plane | an Account Analytics Read token in `ANALYTICS_SQL_API_TOKEN` |
| The control plane at `/control` | `CONTROL_PLANE_ADMINS` names at least one operator |

Unset values fail toward silence by design: no `EMAIL_DOMAIN` means no mail,
an empty `PREVIEW_HOST_SUFFIX` means no previews, and a missing root secret
means every signed-in surface answers 503 while the public pages answer 200.
That last one makes a half-configured site look healthy, which is why step
three exists.
