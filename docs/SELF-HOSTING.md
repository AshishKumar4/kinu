# Self-hosting

kinu.run is one deployment of this repository. A self-host runs the same Worker, containers, and search code. Hosted language runtimes are separate artifacts in `NIMBUS_RUNTIME_CACHE`, and this repository has no reproducible command yet to seed that catalog on a fresh account.

There are two ways to get your own Kinu. The guided one is [kinu.run/deploy](https://kinu.run/deploy): sign in with Cloudflare, answer a few questions, and watch it deploy. [SELF-DEPLOY.md](SELF-DEPLOY.md) describes how that works. This page is the manual route, from a checkout, the way I run kinu.run itself. [DEPLOYMENT.md](DEPLOYMENT.md) is the reference.

## Step one: bring the account

Nothing here can create these for you:

- a Cloudflare account on the Workers Paid plan;
- a zone for the app hostname, active on that account;
- a wrangler login (`npx wrangler login`) with Workers, KV, R2, Vectorize,
  Containers and Email scopes.

Then name your deployment. Every value lives in `packages/cf-backend/wrangler.jsonc`: set your `account_id`, your `routes`, your `CLI_PUBLIC_ORIGIN`, and the KV namespace id that `wrangler kv namespace create kinu-auth` prints. `scripts/deploy.sh` reads the deploy account from `CLOUDFLARE_ACCOUNT_ID`, which defaults to the kinu.run account, so export your own. Commit the configuration. The deploy refuses a dirty checkout, so the build stamp always names the exact bytes that shipped.

The full prerequisite table, with the reason nothing here can create each item, is in [DEPLOYMENT.md](DEPLOYMENT.md#before-you-start). `bun run infra:provision staging` prints staging's worklist; `bun run infra:provision production` prints production's.

## Release signing

Before the first build, I give the self-host its own release-signing key. The installer, CLI updater and device daemon refuse unsigned downloads and releases signed by a key they do not trust. The private key stays on the build machine, never in the Worker, Wrangler secrets, or the repository. One key signs the artifacts staging builds and production promotes.

From the repository root:

```bash
bun scripts/release-signing-key.ts
```

The command writes the Ed25519 private key as PKCS#8 base64 to `~/.config/kinu/release-signing.key`, with mode `0600`, and prints only its path and `RELEASE_SIGNING_PUBLIC_KEY=<64 hex characters>`. It refuses to overwrite an existing key. For another location, set `KINU_RELEASE_SIGNING_KEY_FILE` before generating the key and keep that variable set for every build. I back up the private key outside the checkout.

I copy the printed hex value into both `RELEASE_SIGNING_PUBLIC_KEY` constants:

- `packages/core/src/http/release-signing.ts`, used by the installer launcher and CLI;
- `packages/pc-agent/src/update.js`, used by the device daemon.

Then I check the key against the source pin:

```bash
unset KINU_RELEASE_SIGNING_PUBLIC_KEY
bun scripts/sign-release.ts --check
```

I commit both public pins with the deployment configuration and push that revision before deploying. Setting only `KINU_RELEASE_SIGNING_PUBLIC_KEY` on the build machine does not put the key into shipped clients: that override is for an operator-controlled fixture, not the self-host bootstrap. Existing clients keep trusting the key they shipped with; this procedure starts a new self-host, not a rotation for those clients.

For a build runner with no key file, `KINU_RELEASE_SIGNING_KEY` can supply the same PKCS#8 base64 private key through its secret store. It takes precedence over the file. `scripts/build-cli-dist.sh` runs the signing check before bundling or creating the output directory, and the signer checks the final artifact manifest again. A missing key, missing pin, or mismatched key refuses the build with setup instructions.

## Step two: provision, deploy, provision

```bash
bun run infra:provision staging   # staging's R2 buckets and Vectorize indexes
bun run deploy                    # staging's Worker, DO namespaces, container, routes, cron
bun run infra:provision staging   # staging's secrets; its Worker must exist
```

Provisioning runs twice because `wrangler secret put` refuses on a Worker that does not exist yet. The first run says so, and the second creates nothing the first created. `bun run deploy` runs its required gates before it builds anything. Preflight runs first, the source gates run concurrently, and the two that need the machine or the account to themselves (`gate:hammer`, `gate:infra`) run alone at the end, in that order. A failed gate exits before Wrangler runs.

A fresh deployment has no hosted Python, Bash, Ruby, or Clang until someone supplies a Nimbus runtime catalog. The base workspace and the Cloudflare container still work. I don't promise runtime parity for a fresh self-host until a seed command and a content check exist.

## Step three: prove the account

```bash
bun run gate:infra staging
```

The gate checks that every resource `wrangler.jsonc` declares exists and that the deployed Worker is bound to it. It gives one verdict per resource and exits non-zero on any failure. Anything no CLI can observe is declared with its manual check instead of skipped. `scripts/infra-verify.ts` carries the reasoning.

Production takes the build staging verified:

```bash
bun run infra:provision production
bun run deploy --promote           # production, from staging's verified build
bun run infra:provision production
bun run gate:infra production
```

## Sign-in

A provider appears on `/login` only when both its client id and its client secret are configured. Register your own OAuth application at each provider you want, with the redirect URL:

```text
https://<your-host>/auth/<provider>/callback
```

Client ids are plain vars in `wrangler.jsonc`. Client secrets are Wrangler secrets, and the second provisioning run prompts for them. The Cloudflare provider is the one worth having: signing in with it also connects the user's own Workers AI, so their chat bills their account rather than yours. The exact scopes and grant types are in [DEPLOYMENT.md](DEPLOYMENT.md#oauth-setup).

## What works when

Each surface stays off until its setup step is done. An absent surface is off, not broken.

| Surface | Works after |
| --- | --- |
| Public pages, install script, CLI downloads | the first deploy |
| Signed-in surfaces (web, CLI, credentials) | the root secret is installed |
| Sign-in | you register at least one OAuth application |
| Chat billed to the platform account | the AI Gateway exists and `AI_GATEWAY_URL` names it |
| Chat billed to each user's account | the Cloudflare OAuth application and its secret |
| Previews | a proxied wildcard DNS record under `PREVIEW_HOST_SUFFIX` |
| Email to workspaces | Email Routing onboarding; [EMAIL-INGRESS.md](EMAIL-INGRESS.md) |
| Fleet metrics on the control plane | an Account Analytics Read token in `ANALYTICS_SQL_API_TOKEN` |
| The control plane at `/control` | `CONTROL_PLANE_ADMINS` names at least one operator, and a Cloudflare Access application matches `CONTROL_PLANE_ACCESS_TEAM_DOMAIN` and `CONTROL_PLANE_ACCESS_AUD` |

Unset values fail toward silence on purpose. No `EMAIL_DOMAIN` means no mail. An empty `PREVIEW_HOST_SUFFIX` means no previews. A missing root secret means every signed-in surface answers 503 while the public pages answer 200. That last one makes a half-configured site look healthy, which is why step three exists.
