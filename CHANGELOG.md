# Changelog

All notable changes to Kinu are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version that matters to a user is `packages/cli/package.json`. It is what
`kinu --version`, `kinu doctor` and the served `kinu-version.json`
report. `scripts/build-cli-dist.sh` appends `+<sha>` build metadata at
deploy time, so an installed CLI reads `0.2.0+abc1234`; the changelog tracks the
`0.2.0` part.

## [Unreleased]

### Added

- **The CLI installs as a prebuilt build, not a source checkout.** `install.sh`
  now downloads Bun (when the machine has none), one artifact for the machine's
  platform, and the CPython runtime every platform shares. Nothing else. The
  install used to fetch the whole monorepo as source and run
  `bun install --frozen-lockfile` on it: measured cold on 2026-09-01 on a
  12900K, that was 13.35 s of a 16.08 s install, 950 packages, 105,648 files,
  1.9 GB of disk, and a `workerd` postinstall that shells out to
  `npm install` for a binary. The same install now takes 2.44 s and 144 MB
  across 46 files, and no package manager, registry or postinstall script runs
  on the machine at all. `scripts/build-cli-dist.sh` does the resolving once,
  at deploy time, and refuses to publish a file over Cloudflare's 25 MiB
  per-file asset limit.
- **One install command, and it is a single pipeline.**
  `curl -fsSL 'https://kinu.run/install.sh' | bash`. The
  `KINU_PARENT_ACTIVATES=1` prefix and the `&& export PATH=…` tail are gone;
  the script prints the exact export line once, at the end, when the calling
  shell cannot see `kinu` yet. The landing page and the device-registration
  API now build that string from the same function.

- **The overlay-cas runner can say where a run went: `--profile stderr`.** One
  `[profile]` line per phase carrying the wall time, the store's own counter
  delta for that phase, and whatever else the phase counted: paths walked,
  files re-digested, tree writes. Milliseconds alone cannot tell a phase that
  spent a minute on two thousand FUSE round trips from one that spent a minute
  moving a gigabyte, and on a mount whose per-operation latency is a second that
  is the only distinction worth having. It goes to stderr because stdout carries
  the receipt and exactly one line of it. Off unless asked for: a production run
  passes no sink, pays one branch per phase and allocates nothing.

  It is what eliminated the strategy. See the measurement in the header of
  `packages/devbox/src/overlay-cas.ts`.

- **`@kinu.run/devbox`: an ephemeral Cloudflare container presented as a machine
  that stays.** A container is spot capacity, so the platform can reclaim it
  between two calls and the disk comes back blank. The package makes that look
  like sleep rather than loss: files come back, supervised processes restart, and
  a preview URL keeps its hostname. Three durable-storage strategies ship, all
  three unit-tested and none yet compared by a deployed run. The
  snapshot chain keeps one immutable base plus one cumulative delta as squashfs
  archives in R2, attached as lazy FUSE layers, so an attach moves no bytes and
  costs the same for a work directory of any size. `r2fs` mounts the box prefix
  through s3fs with a bounded disk cache. The chain is always at most two layers
  deep however many checkpoints have happened, and the delta is replaced by an
  atomic `PUT` with the state record written after it, so a crash between the two
  leaves a complete delta the next attach adopts.

  The attach does not run in `onStart`. That hook is awaited inside
  `blockConcurrencyWhile`, where a container cold start and the attach share one
  platform cancel window, and a timer set inside the block is not delivered until
  the block releases, so the bound meant to protect it could never fire. A
  deployed Worker answered 500 with `A call to blockConcurrencyWhile() in a
  Durable Object waited for too long. The call was canceled and the Durable
  Object was reset.` The attach runs in a schedule row instead, and every
  operation awaits a readiness gate.

  A failed attach is classified from the SDK's own error codes rather than from
  its prose, and recovered by one bounded ladder: ask the same container identity
  again at the heartbeat cadence, then destroy and replace that identity, then
  refuse. Storage exhaustion and permanent configuration refuse at once, because
  asking again spends the same resource or reads the same input. The ladder is
  one durable row, and it is claimed: each attempt writes down a token, every
  later write to that row is conditional on the token still being there, and the
  compare and the write happen inside one critical section. So an attempt whose
  write races a newer attempt's success changes nothing instead of resurrecting a
  stage that success had cleared. A terminal refusal KEEPS its stage rather than
  clearing it, because a ladder that reset itself on the next eviction could
  destroy one identity after another; `attachNow()` is the explicit re-attempt,
  it destroys nothing, and any attach that lands deletes the row. Work that the
  attach budget abandoned goes straight to replacement: it is still running
  inside the container, where nothing in the Durable Object can fence it, so
  SIGKILL is the only cancellation there is. Every startup attempt owns a
  lifecycle generation and re-checks it after each await, so an attempt the
  platform superseded publishes no readiness, files no failure and destroys no
  identity.

  One budget covers the whole restoration rather than the attach alone: the
  attach, the workload restart, every listener proof, every exposure and the boot
  stamp. The listener proof used to carry a window per port, so three silent
  ports added about ninety seconds while every caller waited in the readiness
  gate. Every step now draws an allowance from the one clock: what is left
  divided by the steps still to run.

  What exhaustion means depends on what is abandoned. The attach is mid-mount, so
  overrunning it throws and the container identity is replaced. Every step after
  it mutates no mount, so exhaustion is reported instead: the box stays attached,
  its specs stay, no failed port is exposed, and `unready` names what did not come
  back. A slow dev server costs the box its readiness and nothing else, and an
  explicit `attachNow()` retries it. The walk asks the container first, so a
  process it already holds is not started twice.

  Readiness is honest. A port is exposed only after its own listener answers, no
  port is exposed at all when a supervised process failed to restart, and `ready`
  means the attach landed and every process, listener and port came back;
  `unready` carries the reason when it did not. Operations stay permitted while a
  restored service is down, so the agent whose server failed can repair it.

  `KinuSandbox` is now a thin subclass, 211 lines against 294, holding only what
  no other host can supply: the store, the preview zone, the two questions the box
  must ask its owning workspace, and Kinu's own egress and container-event
  interception. The package declares no dependency on any workspace package, and
  a test reads the source and the manifest to keep it that way. Five suites, 111
  tests, measured 2026-08-24.

  Two deployed production-workerd runs of
  `bun scripts/sandbox-durability-probe.ts --run` passed P1 through P6 on
  2026-08-24. Run `31158290` wrote a 64 MiB base, woke in 79 ms, read a deep
  slice in 82 ms, committed 4,096 B, served HTTP 200 before and after restart,
  kept the heartbeat chain alive for 11 minutes while a platform replacement was
  healed, and restored intact after P6. Final-code run `e54c7de8` woke in 443 ms
  and read its deep slice in 72 ms; P3 through P6 also passed. These records
  describe their deployed builds, not later source changes or a latency
  distribution. Future runs persist their complete JSON evidence under
  `bench-artifacts/`.

- **A control plane at `/control`, for operators only.** `ControlPlaneDO` is one
  instance holding a fleet index and an audit log. It carries no business logic:
  every action it exposes proxies an existing `@callable` on the object that
  already owns that state. The surface shows paged users and workspaces,
  incidents, feedback, weighted fleet metrics, run history, jobs, approvals and
  executors. A destructive action needs a fresh sign-in and an explicit
  confirmation. `CONTROL_PLANE_ADMINS` gates the route, and with it unset the
  route answers 404 and no admin link renders. Staging leaves it empty.

- **Three Analytics Engine datasets, and one query path that weights sampling.**
  `AGENT_METRICS`, `FEEDBACK_MARKERS` and `CONTROL_PLANE_OPS`, with `*_staging`
  twins so staging's panels cannot answer with production's numbers. Analytics
  Engine samples writes and retains rows for three months, so every query in
  `analytics/query.ts` weights `_sample_interval` rather than counting rows.
  Queries go through the account SQL API under `ANALYTICS_SQL_API_TOKEN`; without
  it the writes continue and the Metrics tab reports that queries are not
  configured. A gate holds the declared datasets equal to the bound ones.

- **In-product feedback, with the screenshot kept out of the durable row.** The
  app navigation carries a Feedback button. A note can attach a full-page
  screenshot with drawn annotations, or go without one. Bytes land in R2
  (`FEEDBACK_BUCKET`, `kinu-feedback`), and both buckets expire the `feedback/`
  prefix after 90 days, set and read back on 2026-08-24. The control-plane row
  holds the object key and the exact note; the analytics datapoint holds a marker
  with neither the note nor the image.

- **One eval target seam for both backends.** `KINU_EVAL_BACKEND` selects `local`
  or `cloud`, and cloud is never ambient: it must be asked for by name. A cloud
  arm authenticates as the `eval-service` account against staging, so no person's
  session is borrowed and no eval workspace lands in anyone's own account.
  `bun scripts/staging-preflight.ts` answers the one question an arm must settle
  before it spends, which build it is measuring: it compares `git rev-parse
  --short HEAD` against `build.sha` from `/api/health` and refuses a mismatch,
  naming `bun run deploy:staging`. On 2026-08-24 the deployed sha was `17abc2980`
  while the checkout was 27 commits ahead, so an arm that day would have graded
  code nobody had written. `--allow-stale` downgrades the refusal to a warning for
  a deliberate bisect, and the flag is required so that choice sits in the command
  somebody ran rather than being inferred from a log afterwards.

- **Real-runtime probes for three failures only workerd can show.** New workerd
  suites cover recovery from a Durable Object eviction, the unwindowed spend
  aggregate, and the absence of a step cap. Two new required gates ship with
  them: committed patches must reproduce the installed `node_modules`
  (`gate:patch-parity`), and the declared Analytics Engine datasets must equal the
  bound ones. The deploy script currently runs 57 required gate invocations
  before deployment: preflight first, 55 concurrently, and `gate:infra` last.

- Additional agents are ordinary conversations now, created with one click.
  The role+mission spawn dialog is gone: the tab strip's `+` (and the
  sidebar's "+ New agent" row) creates an idle agent immediately, opens its
  conversation, and shows "New agent" until the first message titles it. Each
  agent conversation carries the same Auto/Plan mode control as the main one,
  an editable name in its header (the workspace bar's own rename pattern), and
  its own draft, mode, and reading position, and switching tabs no longer leaks a
  half-typed message or a scroll position into another agent's composer. The
  inherited mission stays internal and is never rendered. In the TUI, the
  Agent Hub gained the same one-key action (`n`): a local peer in the current
  virtual workspace opens in place; a cloud additional agent is created
  through the backend client and announced. `/rename` names a local agent
  permanently, drafts survive workspace switches, and untitled agents read
  "New agent" in the navigator and hub instead of a blank row.

- An interrupted fork now closes its own span in the durable run-event ledger.
  `head_split` went in at dispatch and `head_merge` when the split settled, but
  a fork killed by a process exit, a Durable Object eviction or an operator
  cancel reached the first and never the second, so `run_events` kept a split
  with no outcome, which is byte-for-byte what a fork still in flight looks
  like. The Timeline rendered a "Heads split" span nothing ever closed, and a
  delegation-cost query counted the spend against no result it could see. The
  start-of-life reconciliation that already settles the journal and wakes the
  agent now also appends `head_abandoned` (carrying `abandoned` against
  `headCount`) to the run that carried the split, the same retraction the
  head roster gets, on the other plane that had gone quiet. A fork whose split
  was never recorded is skipped rather than attributed to an unrelated turn.

- The step clock gained a knowledge channel: when a tool keeps failing (the
  same streak the mechanical steer fires on) and a changed call of that
  tool then runs clean, the runtime records the pairing as a durable
  execution-recovery finding and injects the newest five into every later
  step's dynamic-context block, so what a long autonomous episode proves
  about its environment survives compaction, continuation turns and instance
  death instead of dying with the context window. No model call is involved;
  both halves are the runtime's own records; a lucky retry of the identical
  call records nothing. Findings gate nothing and can never enter MEMORY.md
  or the experience library; each broken streak is a queryable
  `execution_recovery` run event.

- `kinu exec --json` now carries the agent's durable run-event ledger: one
  `run_event` line per row, wrapping the row verbatim. That is where the
  delegation nudge (which trigger fired, and whether the model then reached for
  `agents`), the turn's context budget, and a refused mission budget are
  recorded. The rows live in the workspace database, which a one-shot run in a
  container destroys on exit, so nothing outside the process could read them,
  and a benchmark measured zero nudges for want of a channel. Terminal output is
  unchanged. A row is written when its turn settles, so a turn killed mid-flight
  still leaves none.
- `agents` `ask`/`send` now tell the sender what happened to the work:
  `event_id` (the id the eventual report cites), `delivery`
  (`steering_live_turn` / `starts_now` / `queued`) and `subordinate_phase`.
  A busy helper is steered at its next step rather than waited on, and the
  return finally says so.
- `kinu create` warns when the new workspace's model has no connected
  provider, instead of leaving the first turn to discover it.
- Headless turns can now earn a positive evolution signal; previously only a
  negative one was recorded. A `kinu exec` turn that acted on the world and finished clean is
  recorded as an execution-grounded success (`source: execution` in the outcome
  ledger); one that errored is recorded as an execution-grounded failure. User
  feedback is unchanged and still first-class, and the two are kept distinguishable
  rather than blended, and only a person's verdict corroborates a lesson into
  MEMORY.md or settles imported experience.
- A `fast_model` workspace setting: the model the mechanical evolution work runs
  on (outcome classification, failure-cluster labels, one-sentence reflections,
  pattern extraction, sleep-time compression). Unset, it is the chat vendor's own
  small tier where it has one, at the same provider on the same credential, and
  the chat model where it does not.
- The literature citation gate now reads STRING EXPRESSIONS, not just comments.
  Its blind spot was load-bearing: a paper is cited in prose, and the prose this
  repository hands a MODEL lives in tool descriptions and field docstrings that
  nothing had ever read a byte of: 168,682 string expressions across 1,872
  parseable files, 3.7MB of literal text. The unit is the whole expression rather
  than one quote, because a citation and the figures it attributes are routinely
  in different `+`-joined fragments; an interpolation is read as an unknown
  rather than closed over, so `${a}.${b}` is never mistaken for a decimal.
- A string that DECLARES itself a quotation is now compared against the prose it
  names. `Verbatim from `Name`` in the docblock above a string is a checkable
  claim: the target resolves to a declaration anywhere in the corpus, and every
  sentence of it inside the span the quote covers must survive in the quote. An
  excerpt may stop early (a description rendered for a model legitimately drops
  the paragraphs about a refusal). A silent drop from the MIDDLE of what it
  quotes is refused. It caught `MODELS_FIELD_DESCRIPTION` in the axis study
  presenting itself as verbatim while missing `Available on EVERY preset.` and
  the clause carrying Self-MoA's own `up to 3.2x` magnitude, both of which are
  restored. A target this tree does not declare (another program's output, a
  paper, a person, or a field that has since been removed) is counted and named
  on the green path rather than guessed at, and three such targets are named
  there now.

### Changed

- **One deploy path, an immutable container image, and no credential beside
  unreviewed code.** `packages/cf-backend` declared its own `deploy:staging`
  around a bare `wrangler deploy`, and `docs/DEPLOYMENT.md` documented it as the
  way to deploy staging: a path with none of the required gates, neither asset
  check nor smoke test. It is gone: `scripts/deploy.sh` is the only deploy, and
  `scripts/deploy.test.ts` fails if a package script or a document names another
  one.

  Both environments now name the sandbox container by digest
  (`docker.io/cloudflare/sandbox@sha256:822501de…`, which is `0.12.8` as the
  registry resolved it) rather than by a tag anybody who can push that repository
  could re-point under a running deployment. `upload_source_maps` is on and the
  Vite build emits worker maps, so a persisted production stack trace names files
  a person can open; the client build stays without maps, which would otherwise be
  TypeScript served from the public origin.

  Every workflow declares read-only token permissions and checks out with no
  persisted git token. The eval benchmark job (startable by labelling a pull
  request, and holding three secrets) now runs the reviewed base revision instead
  of the branch, and both credential-bearing jobs ask for a GitHub environment.
  The elan installer is a checksum-verified release artifact in one shared action
  instead of `curl … | sh` of somebody's default branch in three workflows, which
  mattered most in the staging deploy, where that toolchain runs inside the step
  holding the Cloudflare token. TruffleHog is pinned to a commit rather than
  `@main`. What no file in a repository can do is narrow an account-scoped API
  token or create a protected environment: docs/DEPLOYMENT.md § Staging deploys
  itself lists those as operator setup.

  The gate runner takes each gate's verdict from `wait -n -p` rather than from a
  status file. A gate whose process was killed without writing one used to be
  detected by probing `kill -0` on an already-reaped pid, which a recycled pid
  answers as a live process: the wave then had nothing left to wait on and spun at
  100% CPU with the deploy unable to finish. A killed gate now settles as
  128+signal, and a gate log directory that cannot be created stops the deploy
  instead of sending every gate's output to `/0.log`.

- **No turn on either backend carries a step cap.** What ends a turn is the model
  finishing without tool calls, the mission budget where a label is scoped, or an
  abort. The vendor loop needs a number rather than a condition and keeps its own
  stop condition as a safety bound, so it is given a step count no turn can reach
  instead of a removed one. Its instance default was 10, which is how the cloud
  backend ran capped at ten steps for the whole time the CLI ran unbounded, with
  both loops' comments asserting parity. A run now seals through one classifier
  over facts the driver observed rather than a string a backend picked: the three
  reasons are `completed`, `aborted` and `error`, an interruption outranks a throw
  so a Stop is never recorded as a failure, and a turn that ended with a tool call
  still pending reports `turn.ended_mid_work` as a defect instead of being given a
  ledger word no run can carry.

- **Nothing puts a deadline on detached work.** A tool call that outlives its
  surface's threshold moves to the background and hands back a handle: 30 seconds
  where a session outlives the turn and can receive a wake, 300 seconds under a
  one-shot process, where a detach truncates the turn and a handle nobody reads is
  worse than waiting. Teardown then gives unsettled work a grace and leaves it
  running rather than joining it. The container's own exec used to send
  `timeout: 60_000` and echo it back as `Command timeout after 60000ms`, and a
  60-second lane ceiling outranks every detach window above it, so a long command
  on the 300-second surface was killed where it should have detached. That ceiling
  is gone. Sandbox commands run in `/workspace`, the directory that survives the
  container being recycled.

- **A preset and a task are a complete `agents.swarm` call.** Five of the six
  named presets score by `verify`, and a verifying composition that named no
  instrument was refused, so `{preset, task}` failed on every row but `ideate`. A
  live turn spent five of its ten steps learning that one refusal per round trip.
  An objective cannot be defaulted, because its metric, unit, direction and target
  are facts about the caller's task. The scorer can be: a named preset handed no
  objective now resolves to the one scorer that needs no instrument, a judge
  ensemble of 3, with selection and carry dropped and depth 1, and it says so.
  Naming an objective is what buys the coverage grid rather than what buys a
  non-refusal. Each refusal that remains names a call that would work. The
  verifier registry is closed and currently holds one kind, `exec-ratio`, whose
  identity carries a digest of the implementation it resolved to, so two runs whose
  kind resolved to different code are not pooled as comparable. The registry is
  asked once, before a run is accepted, whether its instrument can run in this
  workspace at all.

- **A crafted tool is callable as `tools.<name>(args)` on every backend.** The
  cloud sandbox bound crafted tools only under `tools`, while the local sandbox
  bound the same set under both `tools` and `codemode`, so code written against
  the alias on a local workspace threw on a cloud one, and each side spelled its
  own version of the explanation. A crafted tool is a durable artifact the
  experience library carries between workspaces and therefore between backends, so
  the callable shape is a cross-backend contract. `codemode.<name>` stays declared,
  because the generated sandbox types are how a model discovers a tool at all, but
  it is a refusing alias rather than a callable twin, and it refuses by throwing:
  a returned `{error}` reads as a result to the model and as a successful call to
  the runtime, which would let a fitness observation be taken on a call that never
  ran.

- **`kinu spend` and the cost panel report the whole workspace, cumulatively.**
  The number used to be the orchestrator's own turns folded over the same recent
  rows the step telemetry samples, which made every total a floor as soon as the
  log outgrew the window, under a caption a reader could pass over. Producer
  totals are now summed in SQL over every `step_finish` and `model_call` row the
  log holds, so judges, the fast tier, the evolution engine, exploration heads,
  search nodes, compaction and the embedder are all in it. Heads are read from
  their own journal rather than through the model-call sink, because two writers
  for one call is how a total learns to double-count. Coverage is part of the
  answer rather than a footnote: the report states what it could not account for,
  since "everything reported" and "92%, with the embedder silent" are different
  facts. The step telemetry beside it keeps its window, because a cache-hit rate
  over the whole of history answers nobody's question.

- **Profile authority is resolved once, where the runtime is built.**
  `createCLIRuntime` owns it, so a surface with no session of its own is still
  routable and cannot fall back to a second answer assembled somewhere else.

- **Shared turn machinery moved out of both backends into `@kinu.run/core`.** The
  model-call event builder, the turn settle path, steer provenance, automatic
  titling on the CLI, the provider snapshot cache and the default role id each had
  two implementations, and every pair was one fix away from disagreeing. Each is
  one seam now, and the backends hold transport, platform bindings and lifecycle.

- **The product is Kinu, and it runs at https://kinu.run.** Renamed from the
  project's first name, which lived at a hostname on the author's personal
  zone. kinu.run is a new deployment on a dedicated zone, not a rename of a
  running one, so nothing migrates and no redirect, alias or compatibility path
  exists from the old origin.

  The command is `kinu`. Nothing aliases the former command and nothing prints
  a deprecation warning, because a new deployment has no installed base to keep
  working. The served install assets follow it: `/downloads/kinu`,
  `kinu-source.tar.gz` and `kinu-version.json`. The npm scope is `@kinu.run/*`.

  Data does not carry over. Sessions live in a KV namespace instead of D1,
  identities in `UserDO`, and the snapshot bucket and memory index are new and
  empty. Reusing the old ones would have handed a fresh deployment the
  previous one's rows, keyed to user ids this deployment does not assign.
  Staging is a real second environment at https://staging.kinu.run with its own
  stores, and it is the only target tests and evals may run against.

  The rename reaches machine state on the owner's own disk too: the `KINU_*`
  environment variables, `~/.kinu` and the workspace archives under it. A local
  install is renamed in place rather than migrated, which is the one sense in
  which "nothing migrates" does not apply.

- The reason recorded on a head retired by that reconciliation no longer names
  a mechanism it cannot know. It read `settled at start of life, having
  outlived the activation that spawned it`, which asserts a head that ran past
  its owner. That is false for the operator cancel, and phrased like a thrown runtime
  error rather than the bookkeeping entry it is; it was reported as a crash on
  that basis. It now states only the two things observed: the head was spawned,
  never reported, and was retired when a later activation found nothing left
  that could run it.

- **The box you type into when you create a workspace is its MISSION, and only
  that.** It seeds SOUL.md and names the workspace, as it always did, and it is
  no longer also replayed as the workspace's opening chat turn. Creating a
  workspace for "My personal assistant, Jarvis" used to be answered with "this
  is a very short, ambiguous statement", because a standing brief was being
  handed over as a task. The new workspace now opens on an empty conversation
  showing that brief, and waits for the first thing you actually want done. Both
  creation surfaces say so.
- **A workspace's URL no longer carries the prompt that created it.** The slug is
  permanent, since it is the URL and, on the cloud backend, the Durable Object
  name, and it has to be picked before the workspace has a good name, so cutting it
  from the raw text produced `my-personal-jarvis-830c2d` for a workspace that
  called itself "Jarvis" a moment later, and pinned whatever you typed into a
  link you might share. Auto-named workspaces now get a neutral memorable slug
  (`brisk-heron-7f15`); the display name is still derived from the mission and
  still upgraded to a generated title, and renaming is unchanged. Existing
  workspaces keep the slugs they have.
- Automatic titling reads the workspace's mission rather than its first chat
  message. A workspace with no mission of its own still titles from the opening
  request.
- One workspace title on screen instead of three. Identity moved to the
  full-width workspace bar, the only row present at both altitudes, which now
  also carries the connection state, the model picker, settings and the
  Run/Supervise switch; the chat header row is gone, and clearing the transcript
  moved to the chat column's tab strip, beside the tabs it acts on.
- Chat attachments on a LOCAL agent are capped at 8 MiB per message instead of
  1 MiB. The 1 MiB number was a Cloudflare fact, since a chat message is one Durable
  Object SQLite row, that a shared constant had turned into a universal rule,
  so a local session with no row limit at all was refusing screenshots it could
  have carried. Cloud agents are unchanged at 1 MiB, and the cap now comes from
  whichever backend the session is talking to. Over-cap files still become path
  references, which locally the agent can just read.
- The Voyager curriculum proposer uses the configured judge model on cloud
  agents, not the chat model. Proposing tasks is a judging job and the local
  backend already routed it that way; with no judge model configured nothing
  changes.
- A local agent's `agent.*` self-direction namespace is now the same one a
  cloud agent gets. The local copy had drifted: `agent.schedule` accepted a
  cron expression its own scheduler could never fire (the trigger was created
  and simply never ran), and `agent.jobResult` described itself without saying
  what hands back a `{ jobId }` in the first place, so a local agent was
  measurably worse at steering itself, with nothing failing to show it.
- `kinu exec` no longer waits on the heavy evolution cadence before it can
  exit. The turn-level work (outcome review, the sampled scaffold trial) is
  still joined, now under a bound that says what it abandoned instead of waiting
  forever; the session/lifetime pass, covering reflection, scaffold proposal and MCTS, is
  left in the durable window for the local scheduler daemon, which is already
  running for one-shot runs and now picks that work up. On a persisted
  workspace's 25th turn this was minutes of exit stall charged to the task.
- The replay eval no longer runs on the lifetime cadence. It re-executed the
  same graded turns that GEPA's seed scoring already re-executes, for a curve no
  decision reads. It is still available on demand.
- `--no-auto-evolve` now means it: the run records no evolution state at all,
  rather than buffering turns for a later evolution-enabled session to process.
- CLI failures render through one guidance layer: the provider's own words
  plus the exact next command for the failure class (credential, billing,
  unknown model, rate limit, context overflow). `kinu exec --json` carries
  the hint as a field.
- `daemon.log` is capped at 1 MiB with one predecessor kept, and
  `kinu daemon logs` reads across the roll.

- Every executor tool now names the CLASS of its own failure. `sandbox`,
  `nimbus`, `laptop`, `parent` and `workspace` used to answer a descriptive
  string (`exec error: …`, `No device connected.`, `Sandbox executor not
  configured.`) which carried no cause chain and no discriminator, so a caller
  could not tell a timeout from a denial from an OOM. They answer
  `{"reason":"<class>","error":"…"}` instead, reason first, on the same string
  channel; the declared codemode types say so, so LLM-generated code inside
  `execute_tools` can branch on `reason` rather than matching prose. `parent` is
  the deliberate exception and stays as it was: `makeVfsError` already puts the
  parent's errno on its throws and the classifier reads errnos, so a code there
  would be one whose value never varies.

  Three private prose matchers are gone with it. `cf-backend`'s
  `executorOutputIsError` (the Executors-tab terminal) and
  `read-models/workspace-diff.ts`'s `isExecutorFailure` both listed prefixes no
  executor writes any more, and both now call the one shared predicate,
  `isFailingResultText`.

- Four platform conditions stop being counted as tool defects. An unconfigured
  sandbox binding and an unattached laptop were the worst of them: their prose
  was not a failure to any reader, so `run { runtime: … }` recorded outcome
  `ok`, the tool-failure census counted a clean call, and the Executors terminal
  drew exit 0, a platform gap read as success, which nobody goes looking for.
  Sandbox admission refusals that outlive their retries (503 at the ten-instance
  ceiling, 429 on the container start-rate burst) are `unavailable` rather than
  `io`, so the platform's own capacity ceiling is no longer a candidate defect in
  the tool that hit it. And the misevolution veto answered `{ ok: false, error }`
  with no reason, so the census filed the gate *working* under `broke`; it is
  `denied` now.

- Four reads stop claiming absence they never established. `nimbus.listPorts`
  answered `'[]'` when the session handle had no port API at all;
  `sandbox.exists` and `laptop.exists` answered false for a call that was never
  made, and `laptop.exists` swallowed its error to do it; `workspace.readdir`
  answered `[]`. Each refuses with a class instead.

- `parent.exec` honours the abort signal it was already parsing and dropping. It
  was the one executor whose exec could never end as `cancelled`, one class of
  the nine unreachable on one of the five tools, and the comment above it
  claimed the behaviour the code did not have.

- **`fork` has one settlement, and tree search is its own action.** `settle` is
  gone from the `agents` surface, including the `enum: ['merge','mcts']` the
  advertised JSON Schema carried. A fork runs the briefs it was given and merges
  them; `forks` is required, and a call supplying none is refused naming
  `action:'swarm'`. That is where a search writes its own competing candidates
  and measures them, to whatever `depth` is asked for, against an `objective`
  the caller declares through the verifier registry. One field had been making
  one call shape mean two unrelated things: one reading `forks` and merging
  them, the other ignoring them to rank candidates of its own by a judged
  ensemble. The MCTS engine is untouched and stays registered, because the lifetime
  evolution cycle calls it directly, and its durable search store still resumes
  an interrupted tree from the checkpoint. It simply has no route from a
  model-facing field. A stored job row carrying a `settle` is re-driven as
  `{action:'swarm', preset:'ideate', task}` rather than refused, and logs
  `agents.resume.fields_dropped` with `ranking` among the losses, because
  `ideate` returns its candidates unordered.

### Removed

- **Every schema compatibility path, because production is reset.** A table's
  `CREATE TABLE IF NOT EXISTS` is now its genesis. Gone: the column reconcile
  (`reconcileColumns`, `reconcileSqlExecColumns`) and its 30 call sites, the
  `CHECK`-widening rebuilds with their `_legacy` resume branches (`turn_outcomes`,
  `lessons`, `imported_experience`, `experience_library`, `agent_tasks`,
  `head_journal`, `head_merge_results`), the guarded `ALTER TABLE … ADD COLUMN`
  statements (`agent_log`, `release_approvals`), the `craft_scores` backfill, the
  `session_window` and `turn_review_queue` drain, the `agent_identity` and
  `fork_lineage` rename adoption, the `product_*` to `release_*` rename, and the
  pre-FTS5 `memory_chunks` repair. `scripts/schema-drift.ts` holds every DDL to
  `scripts/schema-genesis.lock.json` in both directions, and the lock is
  re-locked at this tree. `crafted_tools` has one DDL owner,
  `@kinu.run/agent-utils` (`initCraftedToolsTables`), the way `memory_chunks`
  already had.
- **The wrangler migration history.** Both environments declare one `v1` tag
  listing every SQLite class. Deploying it needs the old Worker deleted or a
  fresh Worker name; `docs/DEPLOYMENT.md` states the procedure and what wrangler
  does when the step is skipped.
- **The legacy role and the legacy title.** A subordinate's role is a catalog id
  (`RoleId`). The freeform `{ kind: 'legacy', text }` selection, its "Legacy role
  (assigned before this workspace had a role catalog)" prompt block, and the
  `hire`/`ask` fallback that produced it are gone; `hire` and `ask` refuse on an
  actor with no role catalog. The workspace-open heal that titled a pre-titling
  workspace from its `SOUL.md` is gone on both backends; a workspace is titled at
  creation and by its first message.
- **Read-model tolerance for rows written under older shapes.** Delegation
  evidence counts only the live `agents` actions (no `staff`, `think`, `team`,
  `peers`), a subordinate report always carries `sequence_id`, the compaction
  ladder no longer matches the retired `skills` tool, and `search_nodes.root_id`
  is `NOT NULL`.

### Fixed

- Gadget MCP bindings use the connection id for discovery and calls. Boot retries
  retain file-change notifications. The first snapshot includes gadget tabs, and
  removing an open gadget returns the reader to Work.

- Shell approval patterns cover `rm -rf //`, `--no-preserve-root`, `| /bin/sh`, `| sudo sh`, `| dash`, plain `su`, chown flags, refspec-first `git push --force`, setgid modes, reversed `dd` on NVMe and virtio disks, and `mkfs -t`.
- A release cannot record a staging or production deploy without a deploy command; a hostile default branch is refused and fetched as an explicit refspec; an exec result without an exit code fails closed.
- A head that fails to spawn is recorded as errored and its siblings still merge.
- Durable team verbs refuse a temporary (task-lifetime) agent, an assignment rolls back whole, a failed release keeps both errors, and delegation depth clamps at zero.
- The workspace file observer keeps binary before-images and forwards native rename, remove, ranged read and conditional write; a missing path throws ENOENT on both removal paths.
- Experience imports refuse a malformed entry before writing, skip a corrupt row, record the settling turn, and gate on the import checklist; scaffold probation counts vetoes through now.
- Run events insert instead of replace, every event read clamps its limit, and a filtered read pages until it fills; a corrupt hub row is skipped with a diagnostic; an unknown subordinate report answers not_awaited; a 0 rate blocks; the container trust table lives once.
- Views claim their ledger row before writing bytes, delete tolerates a missing live file, and validation refusals carry `bad_input`. Plan reviews fit one platform row.
- Crafted tools cannot take a builtin or `mcp_` name; `record_check` refuses when a release engine is wired; MCTS test selection keeps a prose winner and survives a judge or abort failure; a repeated search root refuses instead of resetting.
- Skills admit the readable ones when one file fails, parse boolean flags strictly, and match spec-dialect tool patterns by family. Memory search degrades per hit, fact confidence clamps to 0..1, fact keys share one normalizer.
- Config setters refuse invalid tiers, policies, modes and severities; counters increment in one statement; usage presence parses per field; curriculum proposals validate count and window and cap what they persist; task statuses are CHECK-constrained.
- Read models clamp every caller limit and fold whole runs; the layergate quarantines a non-serializable observation; extension hooks, structured-JSON fences, prompt-surface entries, prune reservations and Infinity in JSON are handled at their boundaries.

- The advisor answers no note for a reply with no JSON, and delivers a turn with an empty id without a fabricated idempotency key.

- Codex requests opt out of storage on every request shape, including requests that already carry instructions.

- Skill frontmatter keeps type-looking strings such as `"true"` and `"123"` as strings through a save and reload.

- The verify scorer removes the harness modules it writes beside the solution.

- Scope-less scaffold tool calls carry unique ids, so two identical calls in one millisecond both run. A throwing extension hook is recorded and skipped instead of breaking the turn.

- A judge failure rejects the eval run instead of scoring a tie at the quality floor.

- `setMctsOverrides` validates every knob before it writes any, and refuses an integer knob that floors to zero.

- Take-set claims count only the rows they move, so a replayed claim reports zero. Switching a pick moves the terminal marker in one statement. A resumed search prices its remaining budget, not its initial one.

- `nimbus.readFile` on a missing path refuses with reason `missing` instead of answering an empty string. `sandbox.exists` answers a refusal instead of throwing when the transport fails.

- A reset connection classifies as `io`, so a one-shot approval is not refunded for work that may have run. An unparseable URL classifies as `bad_input`.

- Event redaction masks camelCase secret fields such as `authToken` and `clientSecret`.

- An agent view refuses markdown links, images, autolinks and reference definitions, and refuses non-ASCII titles. A tab draws nothing clickable and cannot spoof a host tab name.

- `web` fetch checks every redirect target before it follows the hop, so a page cannot bounce the agent onto a private or metadata address. The body reader stops at the byte cap instead of buffering the whole response.

- Activity log windows use the timestamp and id index instead of sorting the full history.
  Stored history remains append-only.

- **A machine that cannot sandbox tells the model and the owner what its
  daemon said.** The daemon's probe has six statuses. The hub's vocabulary
  had five of them. When bwrap ran and failed in words the daemon does not
  classify, the daemon reported `probe_failed` with the one line that
  explains it, and the hub refused the WHOLE HELLO for the word it did not
  know. Nothing was recorded, not even the platform, and every command was
  refused with `the daemon reported no reason` while the daemon's own log held
  the reason. Measured 2026-09-04 on the first-run tier, where an approved
  command never ran. `probe_failed` is now a reason the hub knows. The
  daemon's line travels on HELLO as `reasonDetail` and is stored beside the
  reason as `sandbox_detail`. The refusal, the model's execution block, the
  Settings row and `kinu connect` all print it. The HELLO schema reads each
  sandbox word as a string and narrows it on its own, so a word the hub does
  not know is kept inside the detail instead of costing the frame. The one
  sentence that survives, `the daemon reported no reason`, now appears only
  when the daemon said nothing.

- **A conversation can move to another Workers AI model after a tool call.**
  Replaying a history that holds a completed tool call through the direct
  Workers AI binding was refused whole: the AI SDK spells an assistant turn
  that only called tools as `content: null` beside its `tool_calls`, which
  OpenAI accepts, and the binding's validator answered AiError 5006 "Type
  mismatch of '/messages/1/content', 'string' not in 'null'". That hit
  `@cf/qwen/qwen3-30b-a3b-fp8` and `@cf/openai/gpt-oss-20b` alike. A
  development or staging workspace that switched model, or resolved a
  different one for a role, lost every turn after its first tool call. The
  adapter now writes that turn's content as the empty string, the same
  message in the spelling the binding admits, with its tool calls and
  reasoning intact; a text-part array, which the binding accepts, still
  travels as it is. Proved on staging: GPT-OSS-20b answered a tool call, and
  the same history replayed to Qwen3-30b produced the sum.

- **An idle overlay-cas box no longer rewrites its whole scan cache every
  interval.** The runner wrote `scan.json` whenever staging took fewer entries
  than the scan measured, as a stand-in for "some cached row is now stale". That
  stand-in is PERMANENTLY true for any upper holding one deleted file or one
  opaque directory: `scanUpper` re-emits a whiteout's `delete` and an opaque
  directory's entry on every single pass. Neither can ever be satisfied by a
  cached row, and `filterChanged` then drops both, because the pending journal
  already holds them. So a box sitting still republished one row per path in its
  workspace, forever, to store bytes identical to the ones already there. The
  documented invariant said it wrote nothing at all; on a deployed 1 MB arm it
  wrote 25,072 B and spent 1,975 ms doing it, every tick.

  The write was not the whole damage. A receipt reporting `entries: 0` with
  nonzero `movedBytes` is deliberately NOT a skip. The adapter reads that pair
  as a real commit, because it is how a redrive whose journal batch already
  landed reports itself. So a box holding one deleted file and doing nothing
  else answered `committed` on every tick and advanced `lastCheckpointAt` each
  time, and `work directory is unchanged` was unreachable for it. The skip that
  branch exists to report now happens.

  `nextScanCache` now reports whether any row actually changed and that answer
  is the write condition, so the rule is decided where the rows are built
  instead of inferred from a count of entries at the call site.

- **A workspace's title is no longer generated from the Durable Object's init
  path.** `OrchestratorAgent.onStart` spawned a fire-and-forget task that read the
  owner's title registry, read SOUL.md and asked a model for a name, so every cold
  start of every claimed workspace launched an LLM call inside
  `blockConcurrencyWhile`, whether or not anybody was looking at the title. The
  gate waited on none of it, which is exactly why it survived review: the hook was
  not `async`, awaited nothing in its own scope, and opened no nested gate.
  Detaching work takes it out of the WAIT, not off the init path. The promise runs
  against an activation whose gate is still open, and an eviction cancels it with
  its rejection swallowed by the runtime, so the title a legacy workspace was owed
  could also simply never arrive.

  The check now runs from the frame that OPENED the workspace: the mount round
  trip the web client makes (`getWorkspaceSnapshot`), guarded once per activation,
  because the answer it produces is durable. That is the only moment the raw slug
  is on somebody's screen, and request-frame model work is ordinary agent work.

  `scripts/do-init-gate.ts` gained the rule that would have refused the shape. Its
  existing rules all ask what the gate WAITS on; the new one asks what the hook
  LAUNCHES, and it is the only one that descends into nested function expressions:
  a call named in the pinned `MODEL_SINKS` list may not appear anywhere inside a
  governed `onStart`. The bounded fork-journal reconcile spawned from the same
  method stays legal, which is the discrimination the rule rests on, and recovery
  hooks are exempt outright. Their sanctioned answer hands a re-drive that may
  reach the model to a detached durable carrier. A pin no source mentions fails
  the gate, and both the exemption and the by-name limit print on the success path.

- **An interrupted durable lane is classified inside the Durable Object's init
  gate and re-driven outside it.** Every entry point (`fetch`, a websocket
  frame, the persisted keepAlive alarm with nobody connected) awaits
  partyserver's `blockConcurrencyWhile`, and inside it the agents SDK awaits
  `_checkRunFibers`, which awaits `onFiberRecovered` once per interrupted
  `cf_agents_runs` row with no timeout of its own. The hook re-drove the lane
  there: an advisor review is a model call, the evolution pass spends model calls
  and real tool loops, a settled background job's re-drive delivers a wake that
  resolves only when the turn it queues ENDS, and the terminal arm replayed every
  owed effect: an SMTP round trip per reply, a wait on another agent's live head
  held every request on that workspace, pure `@callable` reads included; past the
  platform's cancellation window the runtime reset the object; and because the row
  is deleted only when the hook RETURNS. The next wake re-ran the same call: a
  reset loop able to hold a workspace unusable for the whole 24h recovery budget.

  The hook is now synchronous and classification-only. It names the lane, asks
  that lane's own idempotency guard whether anything is still owed (the advisor
  note row, the evolution window claim, the job lease) and hands the re-drive to
  a fresh durable fiber under the same lane name holding the same checkpoint.
  `runFiber` writes that row in its synchronous prefix, so the obligation has a
  carrier before the SDK deletes the row it recovered, and an interruption of the
  re-drive re-enters the same classification with the same inputs. The terminal
  arm replays nothing at all: the owed rows already are the record, so it arms the
  ledger's own retry wake and the alarm frame the module was designed for does the
  replay, under the claim join that makes that re-entry safe.

  `scripts/do-init-gate.ts` audited `onStart` bodies only, which is how a hook the
  same gate awaits stayed outside the repo's own enforcement while the gate printed
  `ok`. It now holds three populations, and the recovery rule states what the other
  two cannot: a method that is neither `async` nor contains an `await` can still
  hand the gate a promise that resolves when a model call finishes, so what a
  recovery hook RETURNS must be a call to the pinned classification seam. Its
  own declaration the gate requires to be synchronous, because a synchronous
  function cannot await. Its blind spots print on the success path.

- **Withdrawn authority now takes effect across the await it was withdrawn
  during.** A Durable Object serializes nothing across an outbound call, so
  between a call's read and its write another call runs to completion. Five
  paths in the user plane were reading before that gap and writing after it.

  Deleting a workspace revoked its capability token AFTER tearing its Durable
  Object down, so for the whole length of that teardown the dying workspace
  still held an identity the owner's registry honoured: it could read
  credentials, list the owner's other workspaces and spend their devices. A
  teardown that failed closed was worse. The marked row deliberately survives,
  and it survived holding a live token indefinitely. The mark and the revoke are
  now one synchronous act before the teardown begins, and the mint re-checks its
  admission in the same turn as its write, so a provisioning call already in
  flight cannot re-issue the identity of a workspace that is being deleted.

  A provider refresh wrote its rotated tokens back unconditionally. Disconnect a
  provider while a refresh was in the air and the reply reconnected the account;
  paste a new credential and the reply overwrote it with a token derived from the
  one just retired; let the provider answer `invalid_grant` and the rejection
  deleted whichever credential was current by then. Each credential key now
  carries a monotonic revision (its writes AND its deletions), and every write
  on a refresh path is a compare-and-swap against the revision read before the
  network call, so the store is the authority and a late reply is dropped.

  The Codex device flow kept one row and deleted it on completion, which left a
  poll nothing to fail against: a reply from an abandoned attempt wrote its own
  tokens over the attempt the owner was actually approving and destroyed that
  attempt's row, and a reply arriving after `disconnect` reconnected the account.
  The row is now settled rather than deleted and carries a generation that rises
  with every `start`, and a poll commits its credential and its settlement
  together under both fences or not at all.

  Creating a workspace whose name was already taken ran the whole birth sequence
  on the live workspace. It re-seeded `SOUL.md` from the new request's mission,
  reset the Output baseline, and opened a second genesis turn beside
  whatever it was already doing. Two creates racing on one name did it to each
  other and a retried request did it to itself. `registerWorkspace` now answers
  with a closed word (`created` / `active` / `reserved`) instead of a boolean:
  `created` is an exclusive claim, `active` returns the workspace as it stands
  with its own title and birth timestamp, and a name an uncommitted fork
  transfer is holding is refused with a 409 instead of being written into.

  A CLI websocket was authorized once, at the upgrade. Revoking the token left
  the established socket holding the workspace's whole `@callable` surface until
  the client chose to disconnect, and hibernation restored the connection from
  its tags with its scopes intact and nothing that named the bearer at all. The
  bearer's token hash and the account's authorization generation now ride the
  connection tags, every frame from such a connection is checked against the
  UserDO that owns revocation before it is dispatched, and a revocation also
  pushes a close to the workspaces holding those sockets so a client that only
  listens stops receiving too.

  One browser approval could mint more than one 180-day CLI token. The flow's
  record lives in KV, which has no compare-and-swap and answers reads from each
  colo's cache, so "mark it consumed, then mint" is not a check. Two polls of
  one approved request could both be handed a token. The approval's identity is
  now stored on the token row itself under a unique index, in the same Durable
  Object and the same statement as the mint, so a second redemption is
  unrepresentable rather than unlikely.

- **A public webhook URL is now a capability, so a workspace name is no longer a
  door.** `POST /api/workspaces/<name>/webhook/<trigger>` resolved the workspace
  object for whatever name the caller typed, before anything knew whether that
  workspace or that trigger existed. Naming one was therefore enough to start a
  persistent Durable Object, with no account and no credential, at whatever rate
  the caller chose. The edge knock budget priced that; it did not close it.
  Nothing upstream could: the control-plane workspace index is best-effort by
  design, and the owner's own registry cannot be asked, because the URL names no
  owner.

  The URL now ends in `v1-<32 hex>`, an HMAC-SHA-256 over the workspace and
  trigger identity under a new `WEBHOOK_ROUTE_SECRET`. The Worker derives it and
  compares in constant time before it spends the ingress budget, before it reads
  the body, and before it addresses any workspace, so an unminted URL answers
  404 and reaches nothing. It is a routing capability and nothing more: the
  trigger's own HMAC, Bearer or mTLS check still decides whether the payload is
  authentic. Nothing durable was added. The capability is derived from facts
  that cannot change, so existing trigger rows need no migration, and the
  workspace name and trigger id are checked against the grammars that issued
  them both where a URL is minted and before any comparison.

  **Every webhook URL in use has to be replaced.** The old unsigned path is
  gone rather than deprecated, because it cannot be made safe. Owners read the
  new URL from the triggers list (the Supervise Automations block, or
  `kinu triggers <workspace> list`) and paste it into whatever posts to it.
  Trigger rows, their secrets and their history are untouched. Without the
  secret, creating a webhook answers 503 and names the variable, and delivery
  answers 404 without waking a workspace; rotating it revokes every URL the
  deployment ever issued. See docs/DEPLOYMENT.md § Rotating WEBHOOK_ROUTE_SECRET.

- **Signing out ends the session at once, everywhere, and only that session.**
  Logout deleted the cookie's KV record and nothing else. A KV delete needs up
  to a minute to reach every colo, so a cookie copied off the browser kept
  working at any colo the delete had not reached. Proven with a two-colo KV
  double: the copy verified back to the full identity after logout had
  returned. A session is now live while one row in the signing-in user's own
  Durable Object says so: sign-in publishes that row before the browser gets a
  cookie, every cookie check reads it, and logout deletes it before anything
  else. The KV delete that follows is cleanup, and the KV record is only the
  identity as it stood at sign-in. Because one row is one session, signing out
  of a borrowed browser leaves a phone and a desktop signed in.

  A store that will not answer is a 503 saying so, never a KV-only pass and
  never the 401 that would send a signed-in user into a sign-in the same outage
  fails. A record that is missing or lapsed stays a plain 401. A record that no
  longer decodes is a fault AND a dead credential, so it is reported once,
  cleared from the row and from KV, and still answered 401, which keeps a
  browser able to sign in again rather than trapped behind a cookie it cannot
  replace. A sign-out that cannot reach the
  store KEEPS the cookie and offers a retry, because that cookie is the only
  handle that can still revoke that session; clearing it would leave the
  session live with nothing able to reach it. Session tokens now carry the user
  id that addresses their authority, so revocation never depends on a cached
  read. Sessions issued before this release stop verifying, and everyone signs
  in once more.
- **A feedback screenshot no longer photographs a secret.** The capture blanked
  password inputs and regions marked for redaction, and none of the app's real
  secret surfaces was either: a webhook secret is shown once as text, the curl
  command that tests it carries the same secret inline, the create dialog's own
  field was a plain text input, and the MCP server form takes
  `{"Authorization": "Bearer …"}` in a textarea. All four reached the screenshot
  bucket. There is one rendering of a credential now, a shared `SecretValue`
  region that carries the redaction marker by construction. The curl command is
  split at its credential rather than interpolated, and the dialog's field is a
  password input as well as a marked region. The browser gate drives those real
  components through the shipped capture and reads the rasteriser's own clone,
  so a secret is proven absent from the text, the attributes, the copied field
  values and the pixels.
- **A feedback body is bounded as it arrives.** `content-length` was the only
  size check, and an absent header parses as zero, so a chunked or HTTP/2
  upload of any size was materialised whole before the screenshot part was
  measured. The body is counted through a reader now and abandoned at the chunk
  carrying the first excess byte, with the upload cancelled rather than drained.
  The declared length stays as an early refusal that reads no body at all.
- **A refused object store is a report we lost, and it says so.** A rejected R2
  write left the request as a platform 500 with no marker and no row, the one
  outcome the rejection rate exists to count, invisible to it. It answers 503
  `storage_unavailable` with exactly one marker now, the same arm a deployment
  with no bucket answers with. A body that is not the multipart it declared
  answers 400 instead of throwing, and every screenshot refusal reports that a
  screenshot was carried and how big it was, instead of claiming there was none.
- `kinu events` renders rows against a cloud workspace, not raw JSON. The
  cloud read answered `{ events: [...] }` where its four sibling list reads and
  the local events read all answer a bare array, so the row formatter's array
  parse failed and it dumped the JSON instead: formatted output on one backend,
  a JSON blob on the other, exit 0 both times. The envelope is gone; the
  ten-field allowlist over each row stays, and the row type is now derived from
  core's event so a field renamed there fails the build rather than dropping out
  of the projection. The `/api/workspaces/<name>/events` HTTP route answers a
  bare array too, being a passthrough of the same read.
- The row formatter no longer degrades silently. A single record riding it,
  `kinu gepa <runId>`, the one legitimate user of its raw-JSON fallback,
  goes to the record printer, which leaves the formatter one legal input shape,
  so an answer that is not a list of rows is now a named refusal pointing at
  `--json`. A new gate reads the formatter's producer inventory out of the
  commands' own source and runs every one of them on a real orchestrator against
  the formatter's own predicate; a sixth list command cannot join without being
  named there.
- The literature citation gate no longer reads a machine-written document as one
  paragraph. Its reach was bounded by the paragraph holding the citation, and a
  recorded run, 206KB of captured model replies with no blank line in it, is
  one paragraph, so a single `Self-MoA` mention governed every integer in the
  file: array indices, JSON structure, and the `-08` out of an ISO timestamp,
  369 findings and not one of them real. Reach is now the structure AND 4000
  characters, measured against the corpus so the same 133 claim sites and 54
  register entries stay governed, and no unit is wider than the reach. A
  minified document has no sentences either, and one 200KB "sentence" put every
  number in it beside any citation in it. The bound is printed on the green path
  with the distance in it.
- Captured output is now a declared category rather than prose. A recording
  declares itself by the timestamp its writer stamps at the head of the
  document, never by living under `runs/`, since a path glob would make the gate
  blind to every future document written there. A recording asserts nothing and
  cannot be corrected without being falsified, so no locator is demanded of it;
  it earns no credit either, and a register entry whose only home is a recording
  is a finding. The exempted files are named, with their count, in the gate's
  own blind-spot list on the green path.
- `scripts/axis-ergonomics/{corpus,surface,validate}.ts` no longer describe
  Self-MoA's homogeneous-versus-mixed result as measured "at identical compute".
  The paper claims no cost parity, since its six mixed proposers span 132B-141B MoE
  downward, so token cost differs, and what it holds fixed is the proposal
  count and topology, six proposals and one aggregator. That is what
  `MODELS_FIELD_DESCRIPTION` declares it quotes verbatim from the spec's own
  `models` field docstring. The gate now reads that position (string
  expressions are part of the corpus, and a declared quotation is compared
  against the declaration it names), and it reports this one as UNCOMPARED,
  because `SwarmInput` no longer declares `models` at all. The field was removed
  from `packages/core` as accepted-and-ignored, so there is no live declaration
  left to compare the study's copy against.
- A literature citation no longer reaches across the code between two comments.
  `citable` joined every comment in a file with a single newline, and a paragraph
  break needs a blank line, so a whole file's comment stream was ONE paragraph:
  a comment opening on a bare digit six lines below an unrelated docblock was
  read as an uncited number belonging to that docblock's paper, and two members
  of one interface had their separate docblocks read as a single sentence. The
  one-character fix (separate every comment) was measured and rejected: a run
  of `//` lines is N separate comments, so it shatters all 10,344 multi-line
  line-comment blocks in the tree into one-line paragraphs and drops real
  coverage, including both `absolute-zero` citations in
  `packages/core/src/curriculum/proposer.ts`. So a unit now ends where its
  AUTHOR ended it: a block comment's closing delimiter says so, and only line
  comments with neither a blank line nor code between them are one block. The
  governed set is byte-identical. Every register entry keeps the same home
  files, and the two claim sites it drops were sentences spliced from two
  different comments, which no author wrote.
- A shell command or file write no longer fails because the shadow-git
  checkpoint before it met a directory the agent may not read. Staging a
  working directory the agent does not own, whether a system temp root, a project
  holding another user's private tree, made `git add` refuse, and the engine
  reported that as `checkpoint staging failed: warning: could not open
  directory 'systemd-private-…'`, which failed the tool call the snapshot was
  protecting: 3 of 4 `execute_tools` failures in one measured run. A path this
  process cannot read is now skipped and NAMED in the checkpoint's own reason
  (`file write [skipped 2 unreadable: …]`), so `/undo` shows an incomplete
  snapshot as incomplete instead of the snapshot being lost entirely. Staging
  also no longer stops at the first refusal, which used to leave every later
  path out of the snapshot without saying so. A staging failure that is NOT a
  permission denial still fails, and both engines, the CLI's and the device
  daemon's, record it identically.
- An eval episode can no longer write into the developer's own repository. The
  local runtime registers a `laptop` executor rooted at `process.cwd()`, and
  the measurement harness inherited it, so an episode reached the filesystem of
  whatever checkout the suite was launched from: one live run left
  `scratch-add/{add.js,add.test.js}` in a worktree root, and `grep -rl 'TODO' /`
  scanned the host. Episodes now open their workspace with no host plane at all
  and work in the workspace filesystem the harness measures; the harness refuses
  a runtime carrying a host executor before any model is driven. Interactive
  CLI use is unchanged.
- `/takes` on a local agent no longer claims a continuation was queued when it
  was not. The local pick reported `continuationQueued: true` the moment it
  dispatched the follow-up, without waiting to learn whether delivery landed,
  so a pick that changed the answer and then went nowhere still read as
  accepted. Both backends now settle on the delivered result, which is what
  the cloud one already did.
- A local agent's `head_split` / `head_merge` no longer appears twice in
  `kinu exec --json`. The split was fanned out both as a broadcast and as a
  run-event row; the broadcast copy reached no reader, since no CLI surface renders
  a head phase, so it was a duplicate line and nothing else. The run-event row
  is unchanged, and it is the one the cloud backend has always written.
- The outcome signal is no longer fabricated in headless use. Every `kinu
  exec` invocation is an independent task, so the next invocation's prompt was
  being read as a conversational follow-up on the previous turn, and the
  classifier counts "asked something new that presumes it worked" as acceptance,
  so essentially every headless turn was labelled `accepted`. That ledger feeds
  the correction rate, GEPA's train/val split, crafted-tool scoring and
  retirement. Conversational grading now happens only where a real follow-up
  exists; elsewhere the turn is graded by the environment or recorded as
  ungraded.
- GEPA's candidate scoring runs on the review model instead of the chat model
  grading its own candidates, the cross-vendor judge selection the shadow eval
  and MCTS already used.
- `workspace.createTool` is now checked by the misevolution gate before a tool
  is persisted: a stored, reusable, shareable tool can no longer name the
  promotion tables, the rollout knobs, the gate's own entry points, or the
  consent settings. Wrapping an HTTP call stays allowed, because the same request runs
  unrestricted in an ephemeral code call, so refusing only its saved form bought
  nothing.
- Deleted `runCraftedToolGepa`, a GEPA→CraftStore bridge with no callers.

- A provider rejection no longer reaches the terminal as a raw object dump
  followed by `error [object Object]`.
- A failed `kinu create` no longer reports itself with a green check.

- **A mid-turn branch that outlives its workspace now settles into Alternate
  Takes, and a failed head no longer keeps its storage forever.** Steer-as-Branch
  journals a branch run's single head under an id derived from the run id, and the
  durable settle both backends replay after an eviction looked that head up under
  the RUN's id instead. It found no row, reported "the journal holds no such branch
  head", and pruned itself, so the comparison the user was owed was dropped
  silently every time the workspace restarted between the branch answering and the
  takes being written, which for a hosted branch is the ordinary case rather than
  the rare one. The replay now reads the head's own id, and reports the head's own
  terminal status: a branch that ran out of wall clock says so instead of being
  recorded as having thrown.

  The same misread status list retained facet storage. The exploration-facet sweep
  classified a facet as finished on `completed` or `aborted` alone, so a head that
  errored or blew its budget was treated as resumable and kept its SQLite storage
  inside the root object permanently, since a facet id is never reused. Every
  terminal report status is now reclaimable and only `running` and `interrupted`
  are held, which is exactly the pair under which work can still continue.

## [0.2.0] - 2026-08-07

The first versioned release. Kinu sat on a frozen `0.1.0` for four months
while the system was built out, so the entries below are reconstructed from git
history and grouped by arc rather than per commit, because there is no earlier
release to diff against. Versioning discipline (see the release checklist at the
bottom of this file) starts here.

### Added

- **Self-evolution loop, closed end to end.** Execution-grounded MCTS rewards,
  the scaffold DGM archive with a misevolution gate and shadow-context parity,
  a detached turn-outcome review, and a replay loss curve. The Evolution
  Changelog surface makes each accepted or vetoed change inspectable, which is
  what let the autonomy switches be turned on.
- **One delegation surface: the `agents` tool.** `fork · staff · ask · send ·
  reply · list · dismiss` behind a single lifetime-keyed ladder, replacing the
  earlier `think` / `team` / `peers` split. The same dispatch is projected into
  the codemode sandbox as the `agents.*` namespace, so a script can fan out,
  branch on results and aggregate. A workflow is just code.
- **Persistent subordinates.** `SubordinateAgent` Durable Object facets with a
  roster, a parent-workspace VFS mount, per-tab facet chat, and a `report` tool
  that carries progress back between turns.
- **Peer workspaces and the mission inbox.** Cross-workspace `ask`/`send`/`reply`
  over the EventsHub peer transport, plus inbound email as a first-class event
  ingress with WAL-intent/idempotency on the outbound side.
- **Experience library.** Owner-scoped sharing of proven crafts, lessons and
  facts across workspaces, gated on local evidence and imported provisionally
  until the importing turn's own outcome corroborates it.
- **Provider breadth.** A 119-provider catalog, Codex/ChatGPT OAuth, a local
  Claude-subscription provider, an opencode bridge, a signed-in Cloudflare AI
  proxy for local workspaces, and user AI Gateway support.
- **Key-less web access.** `web_search` (DuckDuckGo by default, Tavily when a
  credential is stored) and `web_fetch` (Cloudflare markdown service with a
  local HTML→markdown fallback).
- **CLI as a first-class surface.** `create · chat · run · exec · sessions ·
  daemon · doctor · provider · connect · export/import · acp`, an OpenTUI
  terminal UI, session recording and search, checkpoints with `/undo`,
  Alternate Takes, steer-as-branch, and `kinu exec` with `--json` for CI.
- **Agent Client Protocol (ACP)** support, so external editors can drive a
  workspace.
- **Device tunnel.** User-level (not per-agent) tunnel to the owner's machine
  with an ask-once-then-remember consent gate, exposing a `laptop` runtime.
- **Budgets.** Label-scoped transitive USD/token caps on delegated work, with a
  judge-spend short-circuit.
- **Measurement.** A machine-scored evolution benchmark, held-out GEPA splits
  with Wilson intervals, a layer-decomposed deterministic regression gate
  (`bun run layergate`) validated by fault injection, judge calibration with
  Rogan-Gladen/PPI correction, and Harbor/CL-Bench adapters.
- **Lean specification** of the core algorithms under `lean/`, verified by
  `bun run verify:lean`.

### Changed

- **One shared spine.** The turn pipeline, prompting, compaction ladder and
  context budget live in `@kinu.run/core`; the Cloudflare and CLI backends are
  thin adapters over it instead of two drifting implementations.
- **Tool surface consolidated** to 11 built-ins (`BUILTIN_TOOLS` in
  `packages/core/src/tools/registry.ts`). Filesystem work folds into the
  `execute_tools` codemode sandbox rather than living as a dozen flat tools, and
  crafted tools stay inside the sandbox namespace so the schema surface the
  model sees stays flat as the CraftStore grows.
- **`mcts` is a settle policy, not a rung.** It scores fork branches against one
  another by execution instead of merging them; the search itself (UCT, backprop,
  pruning, convergence, resume) is unchanged and fully reachable.
- **Better-compact is the default compaction**, with a navigable archive index
  and an explicit `agent.compactNow`.
- **Prompt caching** wired end to end: Workers AI session affinity, Anthropic
  tool-cache breakpoints, a byte-stable prefix and a real compaction threshold.
- **Capability gate made unavoidable.** Every UserDO-crossing RPC goes through
  one scope table with per-workspace tiers, fail-closed.

### Fixed

- Cloudflare login no longer requires an active Workers AI billing account.
- The alarm chain runs one scheduler with `super.alarm()` restored and stale
  rows swept, ending the missed-trigger class of bugs.
- Heads survive their parent: a head rides its parent's workspace, sandbox and
  executors rather than a divergent copy.
- The web UI no longer renders a failed fetch as if it were the agent's answer.
- MCTS/background jobs survive eviction via lease-epoch fencing and checkpoint
  resume.
- A `pta_` access token can no longer bypass WebSocket scope checks.
- Prompt injection through PDF attachments, and dropped error frames on the
  chat stream, are both closed.

## [0.1.0] - 2026-04-16

Initial tree. The self-evolving agent on Cloudflare Workers, with MCTS
exploration, the evolution engine, the mutable scaffold, and the Agents SDK
integration.

---

## Release checklist

Run this for every user-visible change. It is short on purpose; the parts that
can be mechanically enforced already are (`scripts/deploy.sh` fails its own
smoke gate rather than trusting this list).

1. **Land the work** on a branch with `bun run check`, `bun test` for every
   touched package, and `bun run layergate` green.
2. **Write the changelog entry** under `## [Unreleased]`, in the
   Added/Changed/Fixed/Removed section it belongs to. Describe the behaviour a
   user sees, not the refactor that produced it.
3. **Bump `packages/cli/package.json`**: patch for fixes, minor for new
   user-visible capability, major for a breaking change to the CLI surface,
   the config file, or the recorded-session format. This is the only version
   number in the repo; nothing else needs bumping.
4. **Promote `[Unreleased]`** to the new version with today's date, and open a
   fresh empty `[Unreleased]` above it.
5. **Deploy through `scripts/deploy.sh`.** It builds the source archive, stamps
   `+<sha>` into the shipped version, publishes `kinu-version.json`, and only
   then runs the smoke gate that downloads the tarball and verifies its
   published sha256. A deploy made any other way can ship a tree without
   `downloads/`, which breaks every install and update.
6. **Verify the served version**: `curl -s <origin>/downloads/kinu-version.json`
   should report the version you just published, and `kinu doctor` on a
   throwaway `KINU_HOME` should read `served: <version> (current)`.
