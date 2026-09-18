# Self-deploy: kinu.run/deploy, `kinu deploy cloudflare`, `kinu deploy local`

Design, decided with the owner on 2026-09-15 and 2026-09-16: the deployment
owns its own key, the local account model, no monitor locally; the owner
creates the OAuth client. All five steps of the order of work are built
(2026-09-18); what the local door still owes is named at step 5.
Research and measurements: `~/kinu-logs/self-deploy/RESEARCH.md` and
`oauth-scopes.json` (the 387-scope catalog, read 2026-09-15 with a wrangler
session). The research file's "Option A" is a different thing — Workers Builds
on a repository in the user's account — and this design rejects it; see § Not
in this design.

## The promise

A person with a Cloudflare account and no terminal gets their own Kinu in one
sitting: sign in, answer a few questions with defaults already filled, watch
it deploy, sign in to it. It then keeps itself current. A person who wants to
pay nothing runs the same product on their own machine or a server in their
VPN with one curl. kinu.run never holds anyone's Cloudflare credential.

## What we take from Cloudflare OS, and where we go further

Cloudflare OS's hosted flow (os.cloudflare.app/deploy) is the right shape: one
guided page, sign in with Cloudflare, name the instance, deploy, watch. We keep
that shape. We do better on three things it does not do:

- **No build, no repository, no fork.** The Deploy button forks the repo into
  the user's GitHub and rebuilds there, which makes every user maintain a
  deployment. We publish a prebuilt release artifact and upload it through the
  API. Nothing runs on the user's side.
- **The deployment updates itself.** It holds its own key, checks the release
  channel, and uploads its next version into its own account. kinu.run never
  deploys into anyone's account after the first sitting.
- **One source of truth for what a deployment is.** The release manifest is
  generated from the same `wrangler.jsonc` that deploys kinu.run, so the
  self-hosted shape cannot drift from ours.

## The four surfaces

| Surface | What it is |
|---|---|
| `kinu.run/deploy` | The guided page. Two doors: **Cloudflare** and **your own device**. |
| `kinu deploy cloudflare` | The same flow from the CLI, authorization through a localhost redirect like wrangler. |
| `kinu deploy local` | The same product under local workerd, installed by `curl kinu.run/install-local.sh`. |
| The deployment's own **Updates** page | Where a self-hosted Kinu shows its version, the channel, and updates itself. |

One flow lives in `packages/core` (a plan of idempotent steps with typed
inputs and progress events). The page, the CLI, and the local installer are
adapters over it.

## The release artifact

Every deploy of kinu.run also publishes, beside the CLI tarballs it already
publishes under `/downloads/`:

- `kinu-worker-<version>.tar.gz`: the Worker modules, the static assets with
  their manifest, and `release.json`.
- `release.json`: the version stamp (`{version, sha, builtAt}`, the same one
  `kinu-version.json` carries), the compatibility date and flags, every
  binding with its kind and the resource it needs (generated from
  `wrangler.jsonc` at build), the Durable Object classes and migrations, the
  secrets census (from `scripts/infra-manifest.ts`: prompted, out-of-band, or
  optional, with the text the prompt shows), and the sha256 of every file.
- The seed for the runtime cache bucket (the toolchain blobs), published once
  per Nimbus release and referenced by digest.

The flow never reads the repository. It reads `release.json`.

### What the artifact weighs, and what that costs the run

Measured 2026-09-18 at `d5d744899` with `scripts/build-worker-release.ts`: the
artifact is 27.35 MiB compressed and 107.99 MiB unpacked, 118 modules and 427
assets, biggest single member 21.5 MiB
(`client/_assets/opencode/1.16.2/chunks.json`).

It is installed one member at a time, and it has to be. The flow buffers the
compressed bytes to check the published digest, then walks the archive as a
stream: each asset is encoded into the body it is sent as and let go of when
its batch lands, and only the module set is held to the end, because a version
upload is one multipart request. The artifact is written assets-first for that
reason, so the compressed bytes are released before the module set is held.

What that costs, measured 2026-09-18 in
`packages/cf-backend/tests/workerd/deploy-ledger.test.ts` against a synthetic
release of the same shape (108.46 MiB unpacked, largest member 21.50 MiB):
**88.18 MiB at the peak** — the compressed artifact plus the largest member's
base64 twice, since the transport copies a part into the multipart body. It
does not grow with the release. Before this change the same release cost
243.39 MiB (the whole unpacked archive held for the length of the plan, plus
one 104.08 MiB asset body), and `do.isolate.transient_alloc_reset` in
`packages/core/src/platform-catalog.ts` measured a Durable Object reset about
1.7 s after a transient allocate-and-free of 128 MiB, with the request already
answered 200. So the Cloudflare door could not install this release until
2026-09-18, and now it can, with 40 MiB to spare. `kinu deploy local` reads
the same stream and writes each member straight to disk.

## The Cloudflare door

1. **Sign in with Cloudflare.** A self-managed OAuth client owned by Kinu,
   public with PKCE, so a deployment can refresh its own token without a
   client secret. Scopes: workers scripts, routes, KV, R2, Vectorize, AI, AI
   Gateway, Secrets Store, Access app, policy and org, DNS write, zone read,
   account settings read, user details read, offline access. Every one is in
   the catalog; the first client creation confirms each is selectable.
2. **Account and plan.** The flow reads the account's plan and R2 billing
   state. The lean deployment runs on the free plan; R2 needs a payment method
   on file, and the page links to that one setting. The sandbox needs Workers
   Paid and is off by default; turning it on shows the plan link. No other
   subscription is needed.
3. **Name and address.** Instance name (default: `kinu`), and where it lives:
   `<name>.<subdomain>.workers.dev` by default, or a zone from the account with
   a hostname, in which case the flow creates the DNS record and the route.
4. **Sign-in to your Kinu.** Cloudflare Access with one-time PIN, the way
   Cloudflare OS does it, on the Zero Trust free tier. The flow creates the
   Access application and a policy for the owner's email (more emails can be
   added on the page). Kinu already verifies Access on its control plane; the
   self-hosted profile verifies it on everything. No OAuth app registrations
   at Google or GitHub, which is the part non-technical people cannot do.
5. **Models.** Default model from Workers AI's free tier. Optional keys for
   OpenAI, Anthropic, and OpenRouter, stored as secrets on the deployment,
   never at kinu.run. Subscriptions shared from a connected device work the
   way they do on kinu.run.
6. **Deploy.** The steps run in a Durable Object on kinu.run that holds the
   session's access token only for the run, streams progress over the
   existing WebSocket surface, and wipes the token at the end. Steps, each
   idempotent so a re-run resumes: create KV, the three R2 buckets, the
   Vectorize index with the geometry `release.json` states, the AI Gateway,
   the Access app and policy; seed the runtime cache; upload the Worker
   version with the bindings and migrations from `release.json`; put the
   secrets; bind the address; smoke-check `/api/health`; store the refresh
   token and the deployment record as secrets on the new Worker.
7. **Done.** The page shows the address, the sign-in email, and the connect
   command for the user's computer, with the curl already pointing at their
   instance.

## Updates

The deployment owns its lifecycle. Its Updates page reads the release channel
from kinu.run (`release.json` for `stable`, later `edge`), shows the current
and available versions, and updates on a click or, when the owner turns it
on, on its own schedule. An update is the same upload step run from inside
the deployment with its own token, followed by the same smoke check, and a
failed smoke check keeps the previous version active (versions on Workers are
retained; the flow rolls the deployment pointer back). The daemon and CLI
self-update work already covers the devices.

## The local door

`kinu deploy local` (and, later, `curl kinu.run/install-local.sh | bash`) lays
down, under `~/.kinu/local/`, the same release artifact, a pinned workerd
binary, a generated workerd configuration rendered from `release.json`
(Durable Object storage and KV on local disk, assets from the artifact, the
runtime cache seed unpacked), and a supervisor in the shape of the
existing daemon command. No container
and no monitor: the cron-driven monitor is kinu.run's own uptime probe and has
no job on a local instance. Sign-in is a local account the installer creates
as the default owner, username `local-<short suffix>`, printed once;
onboarding asks for the name as it does today and offers a password, and a
user who skips it keeps the default account bound to that machine. Devices
connect through the same approval flow as kinu.run. Updates are the CLI's update channel with a
different artifact name. The local instance serves `http://` on the port the
command prints, 8787 by default; TLS is the host's concern.

## Not in this design

The CLI and TUI stay standalone agents with no local server (decided
2026-09-15). No sandbox on the local door and none by default on the
Cloudflare door. No user repository and no Workers Builds.

## Order of work

1. **Built 2026-09-18.** Release artifact and `release.json` in the deploy
   pipeline, with a gate that the manifest's bindings equal `wrangler.jsonc`'s.
   The artifact is an R2 object (`RELEASES_BUCKET`, route in
   `packages/core/src/http/release-artifact.ts`); `release.json` and its
   `.sha256` stay static assets.
2. **Built 2026-09-18.** The core flow: `packages/core/src/deploy/` — the plan
   of idempotent steps, typed inputs, the tar reader, PKCE, the run key, and
   the runner over a ledger port. Proved against a fake Cloudflare in
   `packages/core/tests/unit-deploy-flow.test.ts` (12 rows).
3. **Built 2026-09-18.** The door: `DeployRunDO` (one object per run, the step
   ledger in its SQLite, the tokens in its KV side under `secret.`), the public
   `/api/deploy/*` routes gated by a 192-bit run key compared against a stored
   digest, the `/deploy` page, and `kinu deploy cloudflare`. The ledger is
   proved in workerd against real Durable Object SQLite, a fake Cloudflare API
   and a fake authorization server:
   `packages/cf-backend/tests/workerd/deploy-ledger.test.ts` (4 rows).

   What the owner still has to do once, by hand: register the self-managed
   PUBLIC OAuth client (PKCE, no secret) and put its id in
   `CLOUDFLARE_DEPLOY_CLIENT_ID`. Redirects to register: the page's
   `https://kinu.run/deploy/callback` and the CLI's
   `http://localhost:8899/oauth/callback` (`CLI_DEPLOY_REDIRECT_URI`, one
   spelling, in `packages/core/src/deploy/pkce.ts`). Until it is set, `/deploy`
   renders the Cloudflare half as not configured and refuses to start a run;
   `scripts/infra-manifest.ts` carries the row that says so.
4. **Built 2026-09-18.** The deployment's Updates page and self-update:
   `packages/core/src/deploy/update.ts` (the offer, with no version ordering —
   `isSameBuild` is the one comparison), `DeployRunDO.selfUpdate` (the same
   plan, run from inside the deployment with a token minted from its own
   refresh token and a vault that reads through to its live secrets),
   `/api/updates`, `/api/updates/run` and `/api/updates/apply` gated on the
   deployment's own record, and the Updates page that polls the run. Proved in
   workerd against the same fake plane:
   `packages/cf-backend/tests/workerd/deploy-updates.test.ts` (4 rows).
5. **Built 2026-09-18.** The local door: `kinu deploy local` reads the
   channel, lays the release down under `~/.kinu/local/releases/<version>/`
   with a `current` symlink, renders `workerd.capnp` and `config.json` from
   `release.json` (`packages/core/src/deploy/local.ts`), and starts workerd on
   8787 through a pidfile supervisor — `kinu deploy local [start|stop|status]`.
   Durable Object storage and every KV binding are directories under `state/`:
   a KV binding is rendered as `kvNamespace` over a writable disk service, and
   `put`/`get`/`delete` round-trip through a file there (workerd 2026-09-03,
   measured 2026-09-18; a key holding a `/` is the one shape that does not
   answer, and Kinu's keys are `session:`, `oauth-state:` and `ingress:`).
   R2 is not hosted — `r2Bucket` speaks R2's own protocol, which a disk
   directory does not implement — so a bucket is printed by name at install,
   beside Vectorize, AI, the Worker loader, Analytics Engine and the
   container, as what a local instance is without. Proved end to end against
   the real workerd binary in `packages/cli/tests/deploy-local.test.ts` (the
   instance answers on its own port and round-trips its own KV binding), the
   rendering in `packages/core/tests/unit-deploy-flow.test.ts`.

   The pid rule: `workerd.pid` is a hint and never a licence to signal. Every
   read of it confirms the process's own argv names `workerd` and that
   instance's `workerd.capnp` — `/proc/<pid>/cmdline` on Linux, `ps -o args=`
   elsewhere — and the start time is recorded beside the pid for `status`.
   `stop` refuses a pid that fails the test and clears the stale file instead
   of killing whatever inherited the number. Starting is proved the same way:
   the child must still be alive and `/api/health` must answer on the port,
   because a process that already holds the port kills workerd on EADDRINUSE
   while a connect to it still succeeds.

   Still to come: the one-line installer (`curl kinu.run/install-local.sh |
   bash`) that puts a pinned workerd in `~/.kinu/local/bin/` — until then a
   local instance uses the `workerd` on PATH — the runtime cache seed, and the
   local owner account the installer creates.

6. **Not done: the Cloudflare door has never deployed anything.** One real run
   was driven through the plan on 2026-09-18 with an account API token as the
   bearer (instance `kinu-probe-202609181030`, release
   `0.4.0+probe-d5d744899`). It read the account, settled
   `kinu-probe-202609181030.ashishkmr472.workers.dev`, created the KV namespace
   and all four R2 buckets, and stopped at the Vectorize step: `code 10000
   status 403 Authentication error`, the same refusal on a plain
   `GET /vectorize/v2/indexes`, so that token carries no Vectorize permission
   in either direction. Every resource it made was deleted and confirmed gone
   by listing (`kinu-logs/wave4-0917/selfdeploy/measure-*.log`).

   So nothing downstream of Vectorize has been measured: no upload, no
   deployment pointer, no `/api/health` answer from a deployment this flow
   made, and neither of the two version-upload premises in
   `packages/core/src/deploy/steps.ts` (`migrations` only on the first upload,
   `keep_bindings` carrying the live secrets). The next run needs one
   credential that can reach Vectorize; nothing else was missing. The memory
   finding above is the other thing standing between this door and a real
   deployment.
