# Changelog

All notable changes to Kinu are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version that matters to a user is `packages/cli/package.json`. It is what
`kinu --version`, `kinu doctor` and the served `kinu-version.json`
report. `scripts/build-cli-source-archive.sh` appends `+<sha>` build metadata at
deploy time, so an installed CLI reads `0.2.0+abc1234`; the changelog tracks the
`0.2.0` part.

## [Unreleased]

### Added

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
  Object was reset.` The attach runs in a schedule row instead, every operation
  awaits a readiness gate, and a failed attach records an incident, refuses
  operations with its reason and re-arms at the heartbeat cadence.

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
  bound ones. The required-gate count is 54.

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
  same streak the mechanical steer fires on) and a **changed** call of that
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
- Headless turns can now earn a POSITIVE evolution signal, not just a negative
  one. A `kinu exec` turn that acted on the world and finished clean is
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

### Changed

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

- **The product is Kinu, and it runs at https://kinu.run.** Formerly Proteus,
  at a hostname on the author's personal zone. This is the only place that name
  appears: kinu.run is a new deployment on a dedicated zone, not a rename of a
  running one, so nothing migrates and no redirect, alias or compatibility path
  exists from the old origin.

  The command is `kinu`. There is no `proteus` alias and no deprecation
  warning, because a new deployment has no installed base to keep working. The
  served install assets follow it: `/downloads/kinu`,
  `kinu-source.tar.gz` and `kinu-version.json`. The npm scope is `@kinu.run/*`.

  Data does not carry over. Sessions live in a KV namespace instead of D1,
  identities in `UserDO`, and the snapshot bucket and memory index are new and
  empty. Reusing the old ones would have handed a fresh deployment the
  previous one's rows, keyed to user ids this deployment does not assign.
  Staging is a real second environment at https://staging.kinu.run with its own
  stores, and it is the only target tests and evals may run against.

  What deliberately keeps the old spelling is machine state on the owner's own
  disk, not product copy: the `KINU_*` environment variables, `~/.kinu`
  and the workspace archives under it. Breaking a local install is not what
  "nothing migrates" means.

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

### Fixed

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
  `SwarmConfig.models` in `packages/core` had already been corrected to say, and
  what `MODELS_FIELD_DESCRIPTION` claims to quote verbatim. The gate cannot see
  it: a citation inside a string literal is not read, and this one surfaced only
  because a recording echoed the tool's own refusal into a file the gate does
  read. That blind spot is now stated on the green path too.
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

## [0.2.0] - 2026-08-07

The first versioned release. Kinu sat on a frozen `0.1.0` for four months
while the system was built out, so the entries below are reconstructed from git
history and grouped by **arc** rather than per commit, because there is no earlier
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
