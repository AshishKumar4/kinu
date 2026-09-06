# What if Kinu were designed around agent-core's primitives

An investigation, written 2026-09-06. It answers one question: if I designed Kinu around
the primitives in `agent-core` (`/home/mrwhite0racle/agent-core/packages/agent-core/SPEC.md`,
read at commit `2b7f5da9`), while keeping the product as it is, what would that design
be, what would it solve, and is it a good idea. It is not a plan to replace Kinu's code
with agent-core's code. Where agent-core has a complete implementation that passes our
gates, I use it. Where it has none, Kinu keeps its own.

## The two models side by side

agent-core has sixteen primitives in six layers (SPEC §2). Kinu has grown its own
versions of most of them. This table is the mapping, with the Kinu file that owns each
today.

| agent-core primitive | Kinu today | Owner in Kinu |
| --- | --- | --- |
| Principal, Team, Scope (Tenant ⊇ Project ⊇ Workspace) | the owner's `UserDO` (principals, devices, MCP connections, workspace registry); no project layer; one workspace DO per workspace | `cf-backend/src/user/**`, `orchestrator.ts` |
| Grant, Binding, ResolvedFacet | five mechanisms: `TOOL_REACH` ∩ wired deps (`core/src/tools/registry.ts`), `AGENT_RPC_ACCESS` classes (`cli/rpc-gate.ts`), workspace capability tokens, device consent, the binding policy of the app feature | four files, no shared resolver |
| Facet (manifest + runtime), Contribution, Slot | tools, executor providers (`ExecutorProviderSurface`), `@callable` read models, MCP connections; each a different shape | `core/src/tools/**`, `core/src/execution/**`, `orchestrator.ts` |
| Operation, Interceptor | tool `execute(...args)`; prompt assembly and compaction as pipeline steps | `core/src/prompting/**` |
| Environment, Session, tree Checkpoint | the Nimbus workspace in the DO, the sandbox container, the device tunnel; devbox checkpoints | `core/src/vfs/**`, `packages/devbox/**` |
| Slate (versions, deployments) | the app feature (being rebuilt as a Slate) and the release lane (`core/src/release/**`) | two subsystems for one primitive |
| Agent, AgentProfile | profiles catalog, roles, SOUL.md | `core/src/profiles/**`, `identity/**` |
| Run, RunBranch, RunCommit, Turn, TurnLease | runs and run events, the turn pipeline, heads and nodes as sibling branches, fiber recovery | `core/src/orchestrator/**`, `cf-backend/src/fiber-recovery.ts` |
| Event, Subscription | the events hub, triggers, webhooks, schedules | `core/src/events/**` |
| Surface, View | the React tab strip, hand-wired (`SURFACES` in `WorkSurface.tsx`) | `cf-backend/src/components/surfaces/**` |
| Invocation, Approval, Receipt, AuditRecord | deferred approvals, `gateExec`, device consent, release approvals; no receipt or audit record type | `core/src/safety/**`, `core/src/execution/approval.ts` |
| Actor, ContentStore, RecordCodec | Durable Objects with SQLite; the file plane; ad hoc row shapes | everywhere |
| Package, Blueprint | none; the profile catalog and the scaffold are the nearest | — |

agent-core §12 names this assembly by name: "An exploration platform (Proteus-shaped)".
It describes a Workspace DO per workspace, sibling RunBranches as parallel heads, an
orchestration Facet owning search state, scaffolds as a Slate-like resource, and
programmatic tool calling with capabilities passed as Bindings. That is Kinu's shape.

## What agent-core has that is real

Measured 2026-09-06 in the agent-core checkout:

- 407 source files under `src/`: facets for filesystem, shell, memory, task, web, mcp,
  approval gateway, self, environment, device, slate and single-tenant; actors;
  authority (grants, bindings, resolver); slates (runtime, versions, publications,
  deployments, previews, skeletons); workspaces (events, subscriptions, views, plans);
  substrates (sqlite); definition (packages, blueprints).
- 353 test files. `vitest run`: 6,230 pass, 1 fail. The one failure is
  `[C13-OWNERSHIP-MAP]`, which refuses my uncommitted `OWNER-NOTICE-VIEWS.md` because it
  has no owner row; it disappears when the notice is folded into the spec.
- A Lean formal model under `formal/` (2,306 files): `AgentCore`, `RuntimeAssurance`,
  `SpecCnl`. I did not build it in this investigation; that is unmeasured.
- No Cloudflare hosting code. `grep -rli cloudflare src` finds a validator and a
  reconciliation driver, nothing that hosts an Actor on a Durable Object or an
  Environment on a container. SPEC §10 states the profile; the code is Kinu's to write.
- The package is `private: true`, unpublished, with a built `dist` that is not tracked.
  Kinu cannot depend on it from npm today. The precedent here is the vendored anti-slop
  plugin: a pinned upstream commit, a digest per vendored file, and a drift test.

## The design

Kinu keeps its product, its DOs, Nimbus, the sandbox, the devices, MCTS and evolution,
the CLI backend, and the UI. What changes is what those things are made of.

1. **One capability catalog.** Every provider Kinu has today becomes a Facet with a
   manifest: `workspace` (file plane + shell), `sandbox`, `laptop` (devices), `parent`,
   `web`, `memory`, `tasks`, `agents`, one Facet per MCP connection, and the read models.
   Each Operation carries its impact class. `TOOL_REACH`, the codemode namespaces, the
   `@callable` classes and a Slate's bindings are then four projections of one catalog,
   generated, never hand-maintained. The `agents-fields` gate, the capability-parity
   gate and the twin-differential gate exist because those projections drift today.
2. **One authority plane.** A Binding is a name bound to a Facet instance for one
   protection domain, resolved through Grants. The agent's own reach, a sub-agent's
   attenuated reach, a Slate's bindings and a CLI session's access are one resolver.
   Object capability throughout: a Slate that holds a binding holds exactly what the
   agent holds, gated exactly as the agent is gated, and nothing else.
3. **One mediation pipeline.** Every side effect is an Invocation with a tier. In-session
   file writes and reads are `direct` (in-memory checks, no durable write on the call
   path). Shell commands the policy gates, device actions, external sends and deploys are
   `mediated`: intent recorded, approval when required, receipt, audit record, event.
   Kinu's deferred approvals, device consent and release approvals become one pipeline
   with one record set. The hardening ledger's durable-ownership bugs (KINU-007, N004,
   N030) are the class §5.3 leases and §7.4 receipts exist to prevent.
4. **Slates for what the agent builds.** A Slate is the agent's application: source in
   the file plane, immutable versions, previews as running processes with exposed ports
   on the preview rail, bindings passed at boot, publish and deploy mediated. The release
   lane is a Slate deploy; the app feature is a Slate with a Surface.
5. **Surfaces from contributions.** A Facet contributes `surfaces`; the tab strip
   materializes the slot. Files, Environment, Work, Exploration and every Slate arrive
   the same way. Presence rules move from `presence.ts` to the contribution.
6. **Runs, Turns, Events as records.** Heads and nodes are RunBranches of one Run; the
   turn pipeline holds a TurnLease; run events, triggers and webhooks are Events with
   provenance and trust tiers; schedules are Subscriptions. Fiber recovery becomes the
   §10.4 durable-execution profile.
7. **The Tenant Actor.** `UserDO` becomes the Tenant Actor: principals, teams, grants,
   MCP connections, devices. Projects are records in it. Cross-user sharing of Slates and
   Blueprints (§4.6 skeletons, §9.2) becomes a resolver question instead of a feature.

## What it would solve

- The drift class. Four hand-maintained capability projections and their three gates.
- The authority class. Five gating mechanisms with no shared resolver; the ingress
  forgery, staging credential authority and device authority rows in the hardening
  ledger were each a seam between two of them.
- The durability class. No receipts and no leases as types; the turn-ownership and
  checkpoint-rollback bugs were found by review, not by construction.
- The UI class. Tabs, presence and the app feature are hand-wired; a Surface slot makes
  them data.
- Formal ground. Kinu's invariants are measured by gates. agent-core's are stated in
  Lean. The gates stay; the model gives them something to check against.

## What it would cost

- Per-effect mediation. §12 says it of this exact assembly: codemode amortizes admission
  across a whole execution with hundreds of effects, and a rebuild on these primitives
  pays per-effect evidence knowingly. The `direct` tier covers most codemode calls; the
  mediated ones must be profiled before the cutover, per subsystem.
- The hosting layer is ours to write. Actors on DOs, the ContentStore on R2 and SQLite,
  Environments on Nimbus and the container, durable execution across hibernation.
- Two repositories and no package. Until agent-core is published, Kinu vendors it with
  a pinned commit and a drift test, the way anti-slop is vendored.
- Maturity. Version 0.1.0, §15 open questions, one formal model I have not built.

## Is it a good idea

Yes, as the target architecture, adopted by seams, one subsystem at a time, each stage
gated by the tiers this repository already has. No, as a rewrite. The product stays; the
primitives underneath it change where agent-core's version is complete and ours is
weaker, and stay ours where agent-core has no implementation.

## The staged path

| Stage | What lands | What it retires | Proof |
| --- | --- | --- | --- |
| 0 | Slate: `SlateRuntime` with Kinu seams (store on the workspace SQLite, previews on the rail, bindings passed at boot) | the app feature's frame and host, later the release lane | the first-run row, the workerd probe, the conformance suite |
| 1 | The capability catalog: every provider a Facet with a manifest; projections generated | `TOOL_REACH` by hand, the parity and agents-fields gates as separate machinery | the gates read the catalog and stay green |
| 2 | Mediation: one Invocation pipeline with receipts and audit records; the approval-gateway facet | deferred approvals, release approvals and device consent as three code paths | hardening rows 007, N004, N030 re-verified against records |
| 3 | Surfaces from contributions | `SURFACES`, `presence.ts` | the browser tier |
| 4 | Runs, Turns, Events as agent-core records; heads and nodes as RunBranches | fiber recovery as a bespoke module | layergate, the recovery matrix |
| 5 | Tenant Actor and Grants; sharing | capability tokens as the only cross-DO authority | the security tier |

Stage 0 is in progress. Nothing after it starts without its own design record and its
own measured gate.
