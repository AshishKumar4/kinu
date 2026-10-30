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

The flow has to install it one member at a time. It reads the archive as it
downloads, and checks each file against the size and digest the manifest
names before it hands on the file's last piece. Each asset is encoded into the
body it is sent as and released when its batch lands. Only the module set is
held to the end, because a version upload is one multipart request. The
artifact is written assets-first for the same reason, so the last asset has
gone before the module set is held.

Cost, measured 2026-09-18 in
`packages/cf-backend/tests/workerd/deploy-lifecycle.test.ts` against a synthetic
release of the same shape (108.46 MiB unpacked, largest member 21.50 MiB):
**88.18 MiB at the peak**, which is the compressed artifact plus the largest
member's base64 twice, since the transport copies a part into the multipart
body. Before the streaming change the
same release cost 243.39 MiB (the whole unpacked archive held for the length
of the plan, plus one 104.08 MiB asset body), and
`do.isolate.transient_alloc_reset` in `packages/core/src/platform-catalog.ts`
measured a Durable Object reset about 1.7 s after a transient allocate-and-free
of 128 MiB, with the request already answered 200. So the Cloudflare door
could not install this release until 2026-09-18; then it could, with 40 MiB to
spare. `kinu deploy local` reads the same stream and writes each member
straight to disk.

Until 2026-10-30 the run held the compressed artifact whole to check one
digest, so the peak grew with it. A real run of 0.2.0+3029d96cd held 110.32 MiB
at the peak that day, 18 MiB under that reset; the release was 853 members,
193.4 MiB unpacked and 51 MiB compressed, its largest member 22.24 MiB. Now the
peak is the larger of the largest member's base64 twice and the module set
twice in flight. A real run of 0.2.0+2bbd2c560 held 59.32 MiB at the peak the
same day, against 59.3 MiB and 28.3 MiB computed from its manifest.

## The Cloudflare door

1. **Sign in with Cloudflare.** A self-managed OAuth client owned by Kinu,
   public with PKCE, so a deployment can refresh its own token without a
   client secret. Scopes (`CLOUDFLARE_DEPLOY_SCOPES` in
   `packages/core/src/deploy/pkce.ts`) are the OAuth catalog's dot ids
   (`GET /oauth/scopes`): workers scripts, routes, KV, R2, Vectorize, AI
   Gateway, zone read, DNS write, the three mail scopes, user details,
   account settings and offline access. The authorize endpoint refuses the
   old colon names (`invalid_scope` for `account:read`, kinu.run 2026-10-20).
   The mail scopes are the client's optional ones. A declined consent or a
   refused scope comes back to the page with Cloudflare's `error` and
   `error_description`, as does a refused code exchange. The page holds no
   run key: its sign-in is an HttpOnly cookie naming the object that holds
   the grant and the Cloudflare user `GET /user` proved, for an hour, and a
   run is named for that user and its account, so signing in on another
   device finds it (docs/SELF-DEPLOY-FLOW.md § 10). The CLI keeps its run key.
2. **Account and plan.** The lean deployment runs on the free plan. R2 needs
   a payment method on file. The computer needs Workers Paid and is off by
   default. It is a Durable Object-managed container on Cloudflare's managed
   image (`cloudflare/debian-trixie`, D55), so no image travels: the upload
   declares `containers: [{ class_name: "KinuDevbox" }]`, and the `computer`
   step makes its application on the class's namespace, as Wrangler makes one
   with no image. Its golden snapshot installs the pinned tools from the store
   bucket, which `computer-tools` fills from the channel
   (`/downloads/devbox-tools/<sha>.tgz.<n>`, streamed through, two parts of at
   most 256 MiB, under the R2 upload endpoint's 300 MB). Its registry token is
   an account-owned token with Workers Containers Write that `computer-token`
   mints, never asked. With the computer off, none of these runs, and the upload
   leaves out the `KinuDevbox` binding and the container.
   The page's preflight reads whether R2 is on; the plan it cannot read without
   Billing, so it reports "unknown", and a run that meets Workers Free pauses
   on it.
3. **Name and address.** Instance name (default: `kinu`), and where it lives:
   `<name>.<subdomain>.workers.dev` by default, or a hostname in one of the
   account's zones, in which case the flow creates a Workers custom domain,
   which makes the DNS record.
4. **Sign-in to your Kinu.** Built-in sign-in (passkey or password): the
   run mints a one-time setup link, `https://<address>/login?setup=<token>`,
   shown when the run is done. The Worker holds only the token's digest, its
   lapse (7 days) and the owner's Cloudflare email (`KINU_FIRST_OWNER_LINK`),
   and the link creates the first owner once, with that email. No Zero Trust
   setup and no Access application.
5. **Models.** Default model from Workers AI's free tier. Optional keys for
   OpenAI, Anthropic and OpenRouter, stored as secrets on the deployment,
   never at kinu.run. Subscriptions shared from a connected device work the
   way they do on kinu.run.
6. **Deploy.** The steps run in a Durable Object on kinu.run that holds the
   session's access token only for the run, streams progress over the
   existing WebSocket surface, and wipes the token at the end. Each step is
   idempotent, so a re-run resumes; the upload tags its version, so a replay
   reuses it rather than uploading another. A prerequisite refusal (R2 off,
   Workers Paid, a refused sign-in) pauses the run, which asks again every
   15 s; an hour into the pause it lets go of the grant, and keeps what it
   minted and its setup link for seven days before deleting itself. In order: read the account and settle the
   address; create KV, the R2 buckets, the Vectorize index with the geometry
   `release.json` states, the AI Gateway; seed the runtime cache; mint the
   secrets and the first owner's setup link; upload the Worker version with the
   bindings and migrations from `release.json`; bind the address and deploy
   the new version at 0% beside the one serving; smoke-check `/api/health`
   through a version override, for the new version's id and the release's own
   version and sha; send the new version all traffic; store the refresh token
   and the deployment record as secrets on the new Worker. The override is
   there because Cloudflare makes no Version URL for a Worker that implements
   a Durable Object. A first deployment has no previous version, so its upload
   serves at once.
7. **Done.** The page shows the address, the sign-in email, and the connect
   command for the user's PC, with the curl already pointing at their
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

## Live runs

### f44999, 2026-10-21

**What was run:** the plan engine, run locally as the run object runs it, with a scoped token as its bearer.
- Release 0.2.0+62b6c90c6 from kinu.run's channel, then rc30's (b04fac742) from a local channel.
- Instances `kinu-sdtest-10210741`, `-10210754` and `-before-0802`.
- Address on workers.dev; no computer and no mail.
- The handover was left out, since it needs an OAuth grant.

Each instance had a fresh deploy and then an update. Both serve the new version, and each instance is torn down. The
account census afterwards equals the census before.

**What it met:**
- **AI gateway create** was refused with 7001 "Required" without `cache_invalidate_on_update`.
- **The assets upload session** answers `errors: null, messages: null`, which the envelope used to reject.
- **A fresh workers.dev address** answered HTTP 404 after its route was enabled.
  - `-10210741`: enabled at 07:49:23, answered 404 then, served by 07:49:52 (up to 29 s).
  - `-before-0802`: served after one 3 s wait.
  - The smoke asks again for four times the longest seen (platform-catalog `workers_dev.fresh_route_404`).
- **The override reached the serving version, not the staged one.** An update's smoke ran in the second its 0%
  deployment was made, and the override still answered with the old version. Asked again, it reached the new one.
- **Startup refusals:** 4 of 7 uploads of 62b6c90c6, and 1 of 8 of b04fac742, were refused with 10021
  "Script startup exceeded CPU time limit." Each passed when asked again. The validator's readings fell in two modes:
  363–377 ms and 777–949 ms (platform-catalog `worker.startup_ms`). The page names the refusal and offers a retry the
  person presses.

### The owner's free account, 2026-10-21

**What was run:** feat/self-deploy's plan engine and its build 1 (0.2.0+8996748cf) from a test channel, on the owner's
Workers Free account (8158b420), signed in by the owner's consent, without the computer.

**What it met:**
- **The plan:** Cloudflare's Containers list answers 401, code 1000, "Deploying containers requires the Workers Paid
  plan". Preflight then read the plan as 'unknown' and raised no need.
- **R2:** off, 10042 ("Please enable R2 through the Cloudflare Dashboard."). Preflight raised the R2 hand-off; the owner
  turned R2 on.
- **Accepted on Free:** KV, 6 R2 buckets, a Vectorize index and an AI Gateway.
- **Duplicate assets:** two byte-identical assets, whose hash Cloudflare asks for once (631 assets, 630 hashes). The run
  sent the hash twice and refused itself. Now each hash is sent once.
- **Analytics Engine:** the version upload was refused with 10089, "You need to enable Analytics Engine". The owner
  turned it on.
- **Dynamic Workers:** the next upload was refused with 10195, "In order to use Dynamic Workers, you must switch to a
  paid plan", because the Worker binds `LOADER`. That ended the run, and led to the Workers Paid decision
  (SELF-DEPLOY-FLOW.md § 8).
- **The consent screen:** it showed the optional API Tokens permission unticked (the owner's observation); the owner
  ticked it. A token minted from the grant could carry no permission outside the grant's scopes: 1001, "The OAuth
  session does not include the scopes required for the requested permission groups: "Account Analytics Read"".

**Cleanup:** what the run made was torn down, the census equals the census before, the minted token was deleted, and the
grant was revoked.

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
   `packages/cf-backend/tests/workerd/deploy-lifecycle.test.ts` (two journeys).

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
   `packages/cf-backend/tests/workerd/deploy-lifecycle.test.ts` (one journey).
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
