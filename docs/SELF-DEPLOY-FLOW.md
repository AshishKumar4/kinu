# The self-deploy flow, redesigned (design for approval)

Status: approved 2026-10-20, with the decisions of § 9 taken; the API the page reads is built (§ 10), the page is
built against it. `docs/SELF-DEPLOY.md` § The Cloudflare door describes the steps the run takes.

What a person gets: their own Kinu on their own Cloudflare account, at an address they choose, with mail if they want
it, in about ten minutes, without reading Cloudflare's documentation. The page does every step Cloudflare lets it do,
hands off to Cloudflare's dashboard only where Cloudflare requires a person there (paying, buying a domain), and comes
back on its own when that is done.

## 1. Why today's flow fails, and what else is wrong

Measured on production (PersistentKite, 2026-10-20 15:43Z) and read from the code (`core/src/deploy/`):

| # | What | Evidence |
|---|---|---|
| 1 | The page stops at "This Kinu has no Cloudflare OAuth client configured yet": production has no `CLOUDFLARE_DEPLOY_CLIENT_ID`. | `/api/deploy/options` answers `cloudflare: false`; the Worker's settings hold no such secret. |
| 2 | Its scopes are written in a form Cloudflare's OAuth no longer takes (`account:read`), so a registered client would still be refused `invalid_scope`. | `pkce.ts:18-23` against `/oauth/scopes`; the create-client API refuses colon scopes. |
| 3 | The scopes cannot onboard mail or create the Access organization: no Zone Settings, Email Routing Rules or Email Sending, no Access organization write. | `pkce.ts:18-23`; `docs/MAIL.md` § Onboarding names the permissions. |
| 4 | The page calls the registry token "Optional", and the run refuses without it, sandbox off or on. | `steps.ts:447`. |
| 5 | The owner cannot sign in at the end: the deployment selects built-in sign-in and is given no setup token, and Kinu does not accept the Access PIN as a sign-in. | no `KINU_SETUP_TOKEN` in the deploy; `auth/session.ts` reads only its own cookie. |
| 6 | No plan, R2 or Zero Trust check before the run: each surfaces as a mid-run refusal. | `docs/SELF-DEPLOY.md:107-112`. |
| 7 | A mail refusal's words are dropped, and the row settles done. | `mail.ts:33-38,117-121`. |
| 8 | A run whose credential expired cannot restore the secrets it minted; a replayed upload makes another version. | `deploy-do.ts:388-404`, `steps.ts:478-496`. |
| 9 | Errors outside a step (OAuth, listing accounts or zones) reach the person as a generic route error. | `routes.ts:218-240`, `api/context.ts:107-116`. |
| 10 | The run key lives in the tab's `sessionStorage`: a closed tab loses the run. | `DeployPage.tsx:18-33`. |
| 11 | The Access application guards the whole host, and the smoke check sends no Access credential, so it would meet Access's sign-in page; so would `install.sh` and the CLI. | `steps.ts:328,568`. |
| 12 | A consent the person declines, or one Cloudflare refuses a scope for, comes back as "That is not an authorization this flow started.": the callback ignores Cloudflare's error parameters. | `routes.ts:218-224`. |

## 2. Principles

1. **One shell, one question at a time.** The page is a single card with a step rail; each screen has one primary
   action. Back always works; nothing typed is lost.
2. **Check before asking.** As soon as the person is signed in, the page reads their account and shows a checklist.
   A question is asked only when the answer changes what is built.
3. **Cloudflare's own words, then the one action that fixes it.** Every refusal shows Cloudflare's message and code
   verbatim, one plain sentence of what it means, and one button: the fix, or the dashboard page where the fix is made.
4. **Come back on its own.** A dashboard hand-off opens beside the page; the page re-checks when it regains focus and
   every 5 s while the hand-off is open, and moves on when Cloudflare says it is done.
5. **Resumable and idempotent.** Every step reads first and writes only what is missing, so a re-run changes nothing
   that is right. A person can close the tab, come back from another device, sign in again, and continue where it
   stopped.
6. **Say what it costs before it costs.** Free, $5 a month, or a domain's price, stated where the choice is made.

## 3. The flow

| Step | The person sees | The page checks or does |
|---|---|---|
| 0 Start | What they will get, what it costs, about ten minutes. "Continue with Cloudflare". | nothing |
| 1 Connect | Cloudflare's consent screen, then back. | OAuth with PKCE; proves their Cloudflare user (`GET /user`) |
| 2 Ready | The account (only if they have several), the address, the computer and mail, and "Deploy", on one screen; the checklist runs silently and only a line that needs them shows. | § 4, § 5, § 6 |
| 3 Deploying | The current phase in plain words, the seven phases under "Details"; a prerequisite pauses it with one action; a refusal stops it with its fix. | the run (§ 7) |
| 4 Live | Their address, their one-time setup link, the CLI install line. | smoke check passed, traffic moved |

The owner's email is their Cloudflare email; provider keys for other models are set later in the Kinu's Settings, so
neither is asked here. Coming back to a Kinu that exists offers "Add a domain", "Add mail", "New setup link" and its
update; each is a run of the same plan over it (§ 7).

## 4. The account checklist (step 2)

Each line is a read; none writes. They run together as soon as an account is chosen, and again on resume.

| Check | Read | When it fails: Cloudflare's words, then |
|---|---|---|
| The account is reachable with these permissions | `GET /accounts/{a}` | "Sign in again" (consent missing a permission names it) |
| Workers is set up: the account has a workers.dev subdomain | `GET /accounts/{a}/workers/subdomain` | none yet: the run makes one from the account's name (`PUT …/workers/subdomain`, Workers Scripts Write) |
| R2 is enabled (Cloudflare asks for a payment method; no API enables it) | `GET /accounts/{a}/r2/buckets` | "Enable R2" → `dash.cloudflare.com/{a}/r2/overview` in a hand-off; comes back by itself |
| Zero Trust is set up, for sign-in | `GET /accounts/{a}/access/organizations` | only with the Access sign-in (§ 9 decision 1): Zero Trust's first setup is a checkout in the dashboard, even on its free plan |
| Workers plan | see § 8 | only matters for "with its computer" |
| Zones in this account | `GET /zones?account.id={a}` | none: the address step offers workers.dev or adding a domain |

## 5. The address (step 2)

- **workers.dev** (default): `kinu.<subdomain>.workers.dev`, live the moment it deploys. The name offered is the first
  of `kinu`, `kinu-2`, … the account's Workers do not hold (`GET /accounts/{a}/workers/scripts`); a run that finds it
  taken by then takes the next free one itself and says so in its first phase.
- **A domain already on Cloudflare**: pick the zone (only this account's), type the host (`kinu.example.com` or the apex).
  The run binds it as a Workers custom domain, which writes the DNS record. An existing record there is shown, with
  "Use another host" as the fix; the page never overwrites one.
- **A domain registered elsewhere**: the page adds it as a zone (`POST /zones`), shows the two nameservers to set at
  their registrar with copy buttons, and watches the zone become active (`GET /zones/{z}`). Meanwhile the deploy goes
  ahead on workers.dev and moves to the domain when the zone is active; the person is told so, and can leave.
- **Buy a domain**: Registrar has registration and transfer-in endpoints (`POST /accounts/{a}/registrar/registrations`,
  `…/registrations/{domain}/transfer-in`, permission `registrar-domains.admin`), but its billing details, default
  contacts and agreement are set in the dashboard. The page sends the person once to
  `dash.cloudflare.com/{a}/domains/registrations`, and registers there or in the page when the API proves it can
  (§ 11). It watches the account's zones and moves on when the new one appears. A transfer-in is offered with what it
  needs said first: the domain unlocked, DNSSEC off, its EPP code, and one to ten days.

## 6. Mail (step 2)

The fixed mail step (`fix/mail-onboard-records`, 4da08dbb3 and fa5d7aadf) on the zone chosen above, or another zone
in the account. Before anything is written the page lists what it will add (MX, SPF, the sending subdomain's DKIM,
a report-only DMARC if there is none) and what is already there. An existing MX that points elsewhere is shown with
Cloudflare's own words and two choices: keep that mail and use a subdomain (`mail.example.com`), or stop. On the
Workers Free plan Kinu can receive mail and send only to verified addresses; the step says so.

## 7. The run (step 3)

The ledger steps (`deployPlan` in `steps.ts`) shown as seven phases, by one table in `phases.ts` (a step it does not
name sits in the phase of the step before it): Preparing your account (account, the computer's token), Creating storage
(KV, R2, Vectorize, AI Gateway, seed, the computer's tools), Uploading Kinu (secrets, upload, the computer), Putting it
on your address, Setting up mail (left out when there is none), Checking it answers, Going live (promote, handover).

- **Ledger:** unchanged in kind: `DeployRunDO` keeps each step's state, attempts, facts and failure (`deploy-do.ts`).
- **It runs with the tab closed:** the object's alarm drives the plan, as before.
- **Upload, once:** the version carries a `workers/tag` naming this run, its release and its answers; a replayed upload
  lists the Worker's versions and reuses the one with its tag (fixes § 1 row 8).
- **Paused, not refused:** a prerequisite refusal (R2 not turned on; Workers Paid for the computer; a sign-in Cloudflare
  no longer accepts) pauses the run with that need. It asks Cloudflare again every 15 s, and at once whenever the page
  reads it, and carries on from that step when Cloudflare says it is done.
- **The grant is held an hour; what the run made, a week:** an hour into a pause (or an hour after the person last
  acted) the run lets go of their Cloudflare grant and reads "Sign in again". The ledger, the root keys it minted and
  the setup link stay seven days, then the object deletes itself (fixes § 1 row 8).
- **Resume anywhere:** the run is named for the person's Cloudflare user and account. Signing in on any device finds
  it and shows "Continue", which carries on where it stopped (fixes § 1 row 10).
- **Changes and updates are the same plan:** a change (a domain, mail, a new setup link) or an update of a Kinu the
  account runs reads its answers back from the account (its vars, classes and secrets' names) and runs the plan over
  it with its root keys kept, as a self-update does.
- **Every refusal:** Cloudflare's message and code, one sentence of meaning, one action (§ 8). That includes the
  consent itself: a declined consent or a refused scope comes back with Cloudflare's `error` and its description, and
  "Sign in again" (fixes § 1 row 12).

## 8. Refusals and hand-offs

Built as one catalog (`refusals.ts`) keyed by Cloudflare's error code (and the endpoint, where a code is shared or
unmeasured), each entry naming the meaning, the action, and whether it is a need the run pauses on. Its entries: R2
not turned on (10042, the probe's fixture: to measure), the computer on Workers Free (a 403 from `/containers/`:
unmeasured), a sign-in Cloudflare refuses (10000, 9109), no workers.dev subdomain (10063), a secret written before its
version serves (10215). Any code not in it shows Cloudflare's words with "Retry this step"; the page offers to copy
the words of any refusal. The capabilities below are as documented (PersistentKite, 2026-10-20); none of the writes
has been exercised yet.

| Need | Done by the page? | Otherwise |
|---|---|---|
| Read the Workers plan | not under OAuth: `GET /accounts/{a}/subscriptions` needs Billing Read, which the OAuth catalog lacks | inferred from what a Paid-only read answers (§ 11) |
| Buy Workers Paid | no: `POST …/subscriptions` needs Billing Write, and its Workers Paid id is documented for resellers only | the dashboard's Workers plans page (`dash.cloudflare.com/{a}/workers/plans`, inferred: to measure) in a hand-off |
| Enable R2 | no: Cloudflare's own checkout | `dash.cloudflare.com/{a}/r2/overview` in a hand-off |
| workers.dev subdomain | yes, `PUT …/workers/subdomain` | — |
| Zero Trust organization | not end to end: the API makes one, but Zero Trust's first setup is a dashboard checkout, even on its free plan; and a new one signs in with Cloudflare's own login unless a one-time-PIN provider is added | the dashboard's Zero Trust setup |
| Add a zone | yes, `POST /zones` (zone or DNS write) | the registrar's nameservers, which only the person can set |
| Register or transfer a domain | by API once the account's billing, contacts and agreement are set (unexercised) | `dash.cloudflare.com/{a}/domains/registrations` |
| Email Routing, catch-all, sending subdomain, DNS records | yes: `POST /zones/{z}/email/routing/dns`, `PUT …/rules/catch_all`, the sending subdomain, `POST /zones/{z}/dns_records` | — |

## 9. Permissions

The OAuth client asks only for what its steps use, in the catalog's current ids (PersistentKite, 2026-10-20):
`user-details.read`, `account-settings.read`, `workers-scripts.write`, `workers-routes.write`,
`workers-kv-storage.write`, `workers-r2.write`, `vectorize.write`, `ai.write`, `aig.write`, `aig.run`,
`secrets-store.write`, `zone.read`, `dns.write` (which also adds a zone); for mail `zone-settings.write`,
`email-routing-rule.write`, `email-sending.write`; for Access sign-in `access.write`, `access-acct.write`; for buying a
domain in the page `registrar-domains.admin`, asked for only when the person chooses that, by a second consent. The
refresh grant gives the deployment its own token for updates, as today. Billing is not in the catalog, so no payment is
ever taken by the page.

Decisions, taken 2026-10-20:
1. **The owner's first sign-in.** Taken: built-in sign-in with a one-time setup link minted by the run and shown
   on the Ready screen (kept in the run until it is used). It needs no Zero Trust, drops the Access step and two
   permissions, and works on every plan. Access, the alternative, costs a dashboard checkout before the run, a
   one-time-PIN provider the page must add, Kinu accepting Access's token as a sign-in, and an Access exemption for the
   smoke check, `install.sh` and the CLI (§ 1 rows 5, 11).
2. **The computer.** "Kinu with its computer" needs Workers Paid and the registry token Kinu publishes. Taken: the
   registry token is the release's, never asked of the person, and is not required when the computer is off (fixes
   § 1 row 4).

## 10. The page's contract

What the page reads and sends (`packages/cf-backend/src/deploy/routes.ts`); every shape has its valibot schema in
`@kinu.run/core/deploy`, which the page parses with.

**Identity.** `POST /api/deploy/signin` (optional body `{ end: "helper" | "tab" }`) answers `{ location }`, Cloudflare's
authorize URL, and sets two cookies: `__Host-kinu_deploy_state` (the `state` digest, ten minutes, as before) and
`__Host-kinu_deploy_session` (HttpOnly, Secure, SameSite=Lax, an hour). The session cookie names a `DeployRunDO` by its
digest, which holds the PKCE verifier, then the grant and the Cloudflare user `GET /user` proved, for that hour. The
callback lands the grant there and returns to `/deploy` (or, for `helper`, the shared finish page
`/connected?service=cloudflare-deploy`), with `error` and its description on a refusal. No run key is in the page.

| Call | Answer |
|---|---|
| `GET /api/deploy/session` | `{ signedIn, email, accounts: [{id, name}], resume: null \| {runId, account, phase, state}, deployments: [{account, name, url, update}] }` (`DeploySessionSchema`). `deployments` are the Workers in the accounts carrying a deployment record, whichever door made them; `update` is `updateOffer` over the build its `/api/health` answers and the channel's. |
| `GET /api/deploy/preflight?account=` | `{ workersSubdomain, suggestedName, r2: "on"\|"off", plan: "unknown", zones: [{id, name, status, nameservers}], needs, checkedAt }` (`DeployPreflightSchema`); `needs` only what needs the person: `r2`, `signin-again`. `plan` stays "unknown" until § 11 finds a read that tells. |
| `GET /api/deploy/domains?account=&q=` | `[{ name, state: "yours"\|"elsewhere", zone?, status? }]` (`DeployDomainsSchema`); buying is not offered until Registrar's search is measured. |
| `GET /api/deploy/mail?zone=` | `{ host, conflict: null\|{mx, suggestion}, writes, kept }` (`MailPreviewSchema`), each record `{type, name, content, purpose: receive\|send\|sign\|report}`, read by the mail step's own reads (`mailPreview` in `mail.ts`), never written. |
| `POST /api/deploy/runs` (JSON) | `{ kind: "new", account, name, address: {kind: "workers"} \| {kind: "domain", zone \| domain, host}, computer, mail: null \| {host} }`, `{ kind: "change", account, name, address?, mail?, setupLink?: true }` or `{ kind: "update", account, name }` (`DeployRunRequestSchema`) → `{ runId }`. Without a JSON body it is the CLI's run-key mint, as before. |
| `GET /api/deploy/runs/current` | The followed run (`DeployRunViewSchema`): `{ runId, account, state: running\|paused\|refused\|live, phase: {id, index, of, words}, phases: [{id, words, state: done\|running\|waiting\|refused, note?}], paused?, refused?, live?: {url, setupLink, setupLinkExpiresAt, cli, pending?: {domain, nameservers}} }`. A paused run asks Cloudflare again on this read. |
| `POST /api/deploy/runs/current/continue` | After a refusal's action or on resume: the sign-in's grant moves in if the run let go of its own, and the stopped step runs again. Answers the view. |
| `GET /api/deploy/runs/current/socket` | The same view as `deploy.run` frames (`DeployRunFrameSchema`), beside the CLI's `deploy.snapshot` ones. |

A `Need` is `{ id: "r2"\|"plan"\|"signin-again", sentence, action: {label, href?}, details? }`, a refusal
`{ sentence, action, details }`, and `details` Cloudflare's words `{ message, code?, status?, endpoint? }`; an `href` is a
dashboard page opened beside the page, its absence the page's own POST. Errors answer 401 `{error, need}` to sign in,
409 `{error, need}` for a prerequisite or `{error}` while a run is going, 502 `{error, refused}` for Cloudflare's
refusal, 400 or 404 `{error}` for ours.

**Runs.** A page run's object is named `deploy-run.<Cloudflare user>.<account>`, so a sign-in finds it again without
an index, and no other user's sign-in can name it. Its grant is moved out of the sign-in when it begins (a refresh
rotates the refresh token, so two holders would spend each other's). A domain registered elsewhere is added as a zone
when the run begins; the run deploys on workers.dev, keeps the access token (never refreshing the refresh token its
handover gave the deployment) to look at the zone every 15 s for its hour, and runs the plan again onto the host once
Cloudflare calls the zone active. The CLI door (`kinu deploy cloudflare`, its run key) is unchanged.

## 11. To verify

Each on a scratch Cloudflare account: a Paid-only read that tells Free from Paid without Billing; Registrar
registration and transfer-in by API after the dashboard's one-time setup; `POST /zones` under `dns.write` alone; the
exact error codes for R2 not enabled (built on the fixture's 10042), the computer refused on Workers Free (built on a
403 from `/containers/`), a workers.dev subdomain taken (the run tries the account's name, then it with a suffix), an
account with no workers.dev subdomain (built on a 404), an existing DNS record, an MX elsewhere and a Free-plan send
refused; whether Cloudflare revokes an access token when its refresh token is spent; and whether the lean deployment's
turns fit the Free plan's CPU limits.

## 12. Host setup, once (Kinu's operator, not the person)

Register the deploy OAuth client with the scopes of § 9; its id is `CLOUDFLARE_DEPLOY_CLIENT_ID` in `wrangler.jsonc`'s
`vars` for kinu.run and staging (registered 2026-10-20), never sent to a self-host. This was what production was
missing (§ 1 row 1).
