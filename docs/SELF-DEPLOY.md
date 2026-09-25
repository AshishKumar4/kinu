# Self-deploy: kinu.run/deploy, `kinu deploy cloudflare`, `kinu deploy local`

Decided with the owner on 2026-09-15 and 2026-09-16: the deployment owns its
own key, a local instance uses a local account and runs no monitor, and the
owner creates the OAuth client. All five steps of the order of work were built
by 2026-09-18; step 5 names what the local door still owes.
Research and measurements: `~/kinu-logs/self-deploy/RESEARCH.md` and
`oauth-scopes.json` (the 387-scope catalog, read 2026-09-15 with a wrangler
session). The research file's "Option A" is something else (Workers Builds on
a repository in the user's account), and this design rejects it; see § Not in
this design.

## The promise

A person with a Cloudflare account and no terminal gets their own Kinu in one
sitting: sign in, answer a few questions with defaults already filled, watch
it deploy, sign in to it. It then keeps itself current. A person who wants to
pay nothing runs the same product on their own machine or a server in their
VPN with one curl. kinu.run never holds anyone's Cloudflare credential.

## What we take from Cloudflare OS, and where we go further

Cloudflare OS's hosted flow (os.cloudflare.app/deploy) has the shape we want:
one guided page, sign in with Cloudflare, name the instance, deploy, watch. We
keep that shape and add three things it lacks:

- **No build, no repository, no fork.** Its Deploy button forks the repo into
  the user's GitHub and rebuilds there, so every user ends up maintaining a
  deployment. We publish a prebuilt release artifact and upload it through the
  API. Nothing runs on the user's side.
- **The deployment updates itself.** It holds its own key, reads the release
  channel, and uploads its next version into its own account. After the first
  sitting, kinu.run never deploys into anyone's account.
- **One definition of a deployment.** The release manifest is generated from
  the same `wrangler.jsonc` that deploys kinu.run, so the self-hosted shape
  cannot drift from ours.

## The four surfaces

| Surface | What it is |
|---|---|
| `kinu.run/deploy` | The guided page. Two doors: **Cloudflare** and **your own device**. |
| `kinu deploy cloudflare` | The same flow from the CLI, authorization through a localhost redirect like wrangler. |
| `kinu deploy local` | The same product under local workerd, installed by `curl kinu.run/install-local.sh`. |
| The deployment's own **Updates** page | Where a self-hosted Kinu shows its version, the channel, and updates itself. |

The flow lives once, in `packages/core/src/deploy/`: a plan of idempotent
steps with typed inputs and progress events. The page, the CLI and the local
installer are adapters over it.

## The release artifact

Every deploy of kinu.run also publishes, beside the CLI tarballs under
`/downloads/`:

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

Measured 2026-09-18 at `ba33cf283` with `scripts/build-worker-release.ts`: the
artifact is 27.35 MiB compressed and 107.99 MiB unpacked, 118 modules and 427
assets, biggest single member 21.5 MiB
(`client/_assets/opencode/1.16.2/chunks.json`).

The flow has to install it one member at a time. It buffers the compressed
bytes to check the published digest, then walks the archive as a stream. Each
asset is encoded into the body it is sent as and released when its batch
lands. Only the module set is held to the end, because a version upload is
one multipart request. The artifact is written assets-first for the same
reason, so the compressed bytes are released before the module set is held.

Cost, measured 2026-09-18 in
`packages/cf-backend/tests/workerd/deploy-ledger.test.ts` against a synthetic
release of the same shape (108.46 MiB unpacked, largest member 21.50 MiB):
**88.18 MiB at the peak**, which is the compressed artifact plus the largest
member's base64 twice, since the transport copies a part into the multipart
body. The peak does not grow with the release. Before the streaming change the
same release cost 243.39 MiB (the whole unpacked archive held for the length
of the plan, plus one 104.08 MiB asset body), and
`do.isolate.transient_alloc_reset` in `packages/core/src/platform-catalog.ts`
measured a Durable Object reset about 1.7 s after a transient allocate-and-free
of 128 MiB, with the request already answered 200. So the Cloudflare door
could not install this release until 2026-09-18; now it can, with 40 MiB to
spare. `kinu deploy local` reads the same stream and writes each member
straight to disk.

## The Cloudflare door

1. **Sign in with Cloudflare.** A self-managed OAuth client owned by Kinu,
   public with PKCE, so a deployment can refresh its own token without a
   client secret. Scopes (`CLOUDFLARE_DEPLOY_SCOPES` in
   `packages/core/src/deploy/pkce.ts`): workers scripts, routes, KV, R2,
   Vectorize, AI, AI Gateway, Secrets Store, Access, DNS write, zone read,
   account read, user read, offline access. Every one is in the catalog; the
   first client creation confirms each is selectable.
2. **Account and plan.** The lean deployment runs on the free plan. R2 needs
   a payment method on file. The sandbox needs Workers Paid and is off by
   default: with it off, the upload leaves out the `KinuSandbox` binding, and
   it never sends the container. No other subscription is needed. Not built:
   the flow does not read the account's plan or R2 billing state, and the
   page has no sandbox switch and no plan link.
3. **Name and address.** Instance name (default: `kinu`), and where it lives:
   `<name>.<subdomain>.workers.dev` by default, or a hostname in one of the
   account's zones, in which case the flow creates a Workers custom domain,
   which makes the DNS record.
4. **Sign-in to your Kinu.** Cloudflare Access with one-time PIN, the way
   Cloudflare OS does it, on the Zero Trust free tier. The flow creates the
   Access application and a policy for the owner's email. The page sends only
   that one email; adding more is not built. Kinu already verifies Access on
   its control plane; the self-hosted profile verifies it on everything. No
   OAuth app registrations at Google or GitHub, which is the part
   non-technical people cannot do.
5. **Models.** Default model from Workers AI's free tier. Optional keys for
   OpenAI, Anthropic and OpenRouter, stored as secrets on the deployment,
   never at kinu.run. Subscriptions shared from a connected device work the
   way they do on kinu.run.
6. **Deploy.** The steps run in a Durable Object on kinu.run that holds the
   session's access token only for the run, streams progress over the
   existing WebSocket surface, and wipes the token at the end. Each step is
   idempotent, so a re-run resumes. In order: read the account and settle the
   address; create KV, the R2 buckets, the Vectorize index with the geometry
   `release.json` states, the AI Gateway, the Access app and policy; seed the
   runtime cache; mint the secrets; upload the Worker version with the
   bindings and migrations from `release.json`; bind the address and deploy
   the new version at 0% beside the one serving; smoke-check `/api/health`
   through a version override, for the new version's id and the release's own
   version and sha; send the new version all traffic; store the refresh token
   and the deployment record as secrets on the new Worker. The override is
   there because Cloudflare makes no Version URL for a Worker that implements
   a Durable Object. A first deployment has no previous version, so its upload
   serves at once.
7. **Done.** The page shows the address, the sign-in email, and the connect
   command for the user's computer, with the curl already pointing at their
   instance.

## Updates

The deployment owns its lifecycle. Its Updates page reads
`/downloads/release.json` from its channel (kinu.run), shows the current and
available versions, and updates when the owner clicks. An update is the same
plan run from inside the deployment with its own token, ending in the same
smoke check. The new version takes no traffic until it passes that check, so
a failed check leaves the previous version serving, and a retry checks the
new version again. The rotated refresh token stays in the update's Durable
Object, which the one-hour vault expiry does not clear, until the handover
writes it into the Worker after the new version serves: Cloudflare refuses a
secret write while the latest version is not the deployed one. Not built: a
second channel (`edge`) and updates on a schedule. The daemon and CLI
self-update already cover devices.

## The local door

`kinu deploy local` (and, later, `curl kinu.run/install-local.sh | bash`) lays
down, under `~/.kinu/local/`, the same release artifact, a pinned workerd
binary, a workerd configuration rendered from `release.json` (Durable Object
storage and KV on local disk, assets from the artifact, the runtime cache seed
unpacked), and a supervisor in the shape of the existing daemon command. No
container and no monitor: the cron-driven monitor is kinu.run's own uptime
probe and has no job on a local instance. Sign-in is a local account the
installer creates as the default owner, username `local-<short suffix>`,
printed once; onboarding asks for the name as it does today and offers a
password, and a user who skips it keeps the default account bound to that
machine. Devices connect through the same approval flow as kinu.run. Updates
use the CLI's update channel with a different artifact name. The local
instance serves `http://127.0.0.1` on the port the command prints, 8787 by
default; TLS is the host's concern. Step 5 below lists which of these parts
exist today.

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
2. **Built 2026-09-18.** The core flow in `packages/core/src/deploy/`: the
   plan of idempotent steps, typed inputs, the tar reader, PKCE, the run key,
   and the runner over a ledger port. Proved against a fake Cloudflare in
   `packages/core/tests/unit-deploy-flow.test.ts` (25 tests).
3. **Built 2026-09-18.** The door: `DeployRunDO` (one object per run, the step
   ledger in its SQLite, the tokens in its KV side under `secret.`), the public
   `/api/deploy/*` routes gated by a 192-bit run key compared against a stored
   digest, the `/deploy` page, and `kinu deploy cloudflare`. The ledger is
   proved in workerd against real Durable Object SQLite, a fake Cloudflare API
   and a fake authorization server:
   `packages/cf-backend/tests/workerd/deploy-ledger.test.ts` (12 tests).

   What the owner still has to do once, by hand: register the self-managed
   PUBLIC OAuth client (PKCE, no secret) and put its id in
   `CLOUDFLARE_DEPLOY_CLIENT_ID`. Redirects to register: the page's
   `https://kinu.run/deploy/callback` and the CLI's
   `http://localhost:8899/oauth/callback` (`CLI_DEPLOY_REDIRECT_URI`, one
   spelling, in `packages/core/src/deploy/pkce.ts`). Until it is set, `/deploy`
   renders the Cloudflare half as not configured and refuses to start a run;
   `scripts/infra-manifest.ts` carries the row that says so.
4. **Built 2026-09-18.** The deployment's Updates page and self-update:
   `packages/core/src/deploy/update.ts` (the offer; it does not order
   versions, and `isSameBuild` is the one comparison), `DeployRunDO.selfUpdate`
   (the same plan, run from inside the deployment with a token minted from its
   own refresh token and a vault that reads through to its live secrets),
   `/api/updates`, `/api/updates/run` and `/api/updates/apply` gated on the
   deployment's own record, and the Updates page that polls the run. Proved in
   workerd against the same fake plane:
   `packages/cf-backend/tests/workerd/deploy-updates.test.ts` (7 tests).
5. **Built 2026-09-18.** The local door: `kinu deploy local` reads the
   channel, lays the release down under `~/.kinu/local/releases/<version>/`
   with a `current` symlink, renders `workerd.capnp` and `config.json` from
   `release.json` (`packages/core/src/deploy/local.ts`), and starts workerd on
   8787 through a pidfile supervisor (`kinu deploy local [start|stop|status]`).
   Durable Object storage and every KV binding are directories under `state/`:
   a KV binding is rendered as `kvNamespace` over a writable disk service, and
   `put`/`get`/`delete` round-trip through a file there (workerd 2026-09-03,
   measured 2026-09-18; a key holding a `/` is the one shape that does not
   answer, and Kinu's keys are `session:`, `oauth-state:` and `ingress:`).
   R2 is not hosted: `r2Bucket` speaks R2's own protocol, which a disk
   directory does not implement. So the install prints each bucket by name,
   beside Vectorize, AI, the Worker loader, Analytics Engine and the
   container, as what a local instance goes without. Proved end to end against
   the real workerd binary in `packages/cli/tests/deploy-local.test.ts` (the
   instance answers on its own port and round-trips its own KV binding), the
   rendering in `packages/core/tests/unit-deploy-flow.test.ts`.

   The pid rule: `workerd.pid` is a hint and never a licence to signal. Every
   read of it confirms the process's own argv names `workerd` and that
   instance's `workerd.capnp` (`/proc/<pid>/cmdline` on Linux, `ps -o args=`
   elsewhere), and the start time is recorded beside the pid for `status`.
   `stop` refuses a pid that fails the test and clears the stale file instead
   of killing whatever inherited the number. Starting is proved the same way:
   the child must still be alive and `/api/health` must answer on the port,
   because a process that already holds the port kills workerd on EADDRINUSE
   while a connect to it still succeeds.

   **Measured against a real release 2026-09-21**, for the first time: the
   published `0.2.0+7cb7078c8` installed and workerd exited on its first
   member. Three defects, each fixed with its red pin:
   - The renderer embedded the one `esbuild-*.wasm` member as an ES module
     (`wasm = embed` now, `unit-deploy-flow`).
   - The release builder packed everything under `dist/kinu`, where the Vite
     plugin also writes `.vite/manifest.json` and this checkout's `.dev.vars`,
     so every tarball published since 2026-09-18 carried the local-dev root
     key. A member is now only what the runtime loads, `.js` or `.wasm` under
     no dot-path (`scripts/deploy.test.ts`).
   - Both doors read `/api/health`'s `version` at the top level while the
     product answers it under `build`, and the release carried no
     `downloads/kinu-version.json` for health to answer from, so no door
     deployment could have passed its own smoke step. Fixed with one
     `HealthAnswerSchema` in `core/src/deploy/update.ts` and the stamp written
     into the release.

   With the three fixed, `kinu deploy local --origin <channel>` installs,
   starts, and answers `/api/health` with its build, and `/`, `/login` and
   `/api/deploy/options` with 200 (`kinu-logs/self-host-0921/`).

   Still to come: the one-line installer (`curl kinu.run/install-local.sh |
   bash`) that puts a pinned workerd in `~/.kinu/local/bin/` (until then a
   local instance uses the `workerd` on PATH), the runtime cache seed, and the
   local owner account the installer creates. Until that account exists a
   local instance has no `CREDENTIAL_ENCRYPTION_KEY` and no sign-in: every
   signed-in surface answers 503 and the public ones answer.

6. **Not done: the Cloudflare door has never deployed anything.** One real run
   was driven through the plan on 2026-09-18 with an account API token as the
   bearer (instance `kinu-probe-202609181030`, release
   `0.4.0+probe-ba33cf283`). It read the account, settled
   `kinu-probe-202609181030.ashishkmr472.workers.dev`, created the KV namespace
   and all four R2 buckets, and stopped at the Vectorize step: `code 10000
   status 403 Authentication error`, the same refusal on a plain
   `GET /vectorize/v2/indexes`, so that token carries no Vectorize permission
   in either direction. Every resource it made was deleted and confirmed gone
   by listing (`kinu-logs/wave4-0917/selfdeploy/measure-*.log`).

   So nothing downstream of Vectorize has been measured: no upload, no
   deployment, no `/api/health` answer from a deployment this flow made, and
   none of the premises in `packages/core/src/deploy/steps.ts` (`migrations`
   only on the first upload, `keep_bindings` carrying the live secrets, a
   deployment taking a version at 0%, a version override reaching it). The
   next run needs one credential that can reach Vectorize; nothing else was
   missing.
