# What if Kinu were designed around agent-core's primitives?

This is the investigation requested on 2026-09-06, reviewed against the current
Kinu source on 2026-09-07. It is not authorization to replace the product, rewrite
its core, or retire its release lane. The user asked for general authored
JS/JSX/TS/TSX client/server applications, called **slates**, composed from the
calling agent's actual capabilities. The broader agent-core redesign was a
**what-if**, preserving Kinu's product.

## What is adopted, and what is not

The vendored pin is recorded in `packages/agent-core/upstream.json`:
`2baebbd45dbf98a168e3101f52e848a313718d76`. The drift test checks vendored bytes;
it does not prove Kinu's adapters satisfy every agent-core invariant. The original
investigation read an earlier upstream checkout. Its test counts and formal-source
counts are not current acceptance evidence, and no Lean build was performed here.

| Area | Actual Kinu implementation | Relationship to agent-core |
| --- | --- | --- |
| Slate records and versions | `core/src/slates/runtime.ts` constructs the vendored `SlateRuntime`; `store.ts` implements `SlateStore` using vendored codecs | Implemented reuse, not merely shared terminology. `synchronize`, `commit`, `fork`, and source restoration use those records. |
| Authored source | `SlateFiles` captures content-addressed trees; `WorkspaceSlateMutation` restores them inside the outer VFS transaction | Kinu hosting seam for the vendored mutation contract. Filesystem authority remains Nimbus credentials. |
| Resident preview | `cf-backend/src/slates/resident.ts` compiles authored server and browser modules through `EsbuildService`, then starts a Fabric process and registers its workspace port | Live Kinu/Nimbus process infrastructure. It is not the vendored durable `SlatePreview` validation/link protocol. |
| Public slate operations | `SlateOperationSchema` and `workspace.slate` expose list, preview, call, commit, history, fork, restore | Implemented product surface. Native builtins remain eight. |
| Publication, deployment, resource provisioning | Vendored interfaces and Kinu's `WorkspaceSlates` adapter exist; the live `SlateHost` does not supply deployment/invocation/preview-validation capabilities | Not product-complete by the existence of tables or methods. Attempts needing absent capabilities refuse `unsupported`; these operations are not exposed by `workspace.slate`. |
| Existing releases | `core/src/release/**` retains its own release workflow | Not converted into `SlateDeployment`; no proof establishes that one is a substitute for the other. |
| Broad authority/composition adoption | Direct `@agent-core/core` imports in Kinu core are concentrated in `core/src/slates/**` | No universal Facet/Grant/Binding/Operation composition cutover has occurred. |

## Similar names are not equivalence

**Facet.** A Kinu `SubordinateAgent` is a Cloudflare Agents SDK Durable Object facet:
its identity, routing, lifecycle and storage are provided by `agents` and
`ctx.facets`. An agent-core `Facet` has a manifest, operation descriptors,
contributions, protection domains and lifecycle interfaces
(`dist/facets-public.d.ts`). The former is a hosting mechanism; it does not thereby
implement the latter. Nimbus process facets are another hosting mechanism, not
proof of an agent-core Facet contract either.

**Binding.** Kinu's `slate.bindings` declaration selects existing namespace, MCP,
read-model or app capabilities. Its introduced `SlateBinding` is a Workers
loopback entrypoint. The vendored `authority/Binding` is a record addressed by
scope, subject, protection domain and name, with grant identity, facet reference,
generation, revision and credential custody. Kinu's declaration and transport do
not implement that record or its grant resolver. They must still preserve the
calling actor's authority; adopting the name alone would not establish this.

**Surface and View.** Kinu's Work/Files/Environment/slate tabs are React product
surfaces with their own presence and navigation rules. Agent-core's
`workspaces/View` is a revisioned record with `SurfaceId`, `SurfaceEpoch`, cursor,
JSON body, action descriptors and optional decision-intent/trust marks. It is not
a JSX renderer or a requirement to encode the authored application in a custom
DSL. A future renderer could display authored code while participating in that
view protocol, but Kinu does not currently construct those View records.

**Run and receipt.** Kinu's run events, terminal-effect ledger, deferred approvals,
device consent and release records have their own owners and recovery rules.
They are not agent-core `RunCommit`, `TurnLease`, `Receipt` or `AuditRecord` merely
because they solve related problems. Reuse needs a state-transition and authority
comparison, including cancellation, replay, ownership and externally visible
results—not a table matching nouns.

## The authority boundary the current slate must preserve

`ActorAgent` supplies a slate caller from its SDK actor path and provisioned
credential. The workspace owns source storage and processes, not the authority to
impersonate every caller. Source capture and compilation use the caller's reads;
restoration uses the caller's writes. Cache identity includes uid, gid,
supplementary groups and umask as well as the actor path where appropriate.

Introduced namespace/MCP/read-model calls return through native-only actor
routing. A facet's capabilities are dispatched on that facet, not reconstructed
from the root's providers. Role narrowing uses the current actor role and the
existing native-tool/codemode policy. App calls retain the originating actor.
The host-owned read models remain a separate capability from the facet's own
files or tools. Successful MCP/read-model data is not a refusal because it happens
to contain `reason` and `error` fields.

These are implementation obligations regardless of whether the larger agent-core
architecture is adopted. The existing deferred-approval queue remains the
side-effect gate; slates introduce no additional approval ladder.

## The what-if design

A deeper composition around agent-core would make workspace, sandbox, device,
memory, tasks, MCP connections and user-facing capabilities Facets. A manifest
could supply operation descriptors and contributions; one authority resolver
could produce the actor's admitted bindings; Surface contributions could populate
UI slots. Runs, durable invocation evidence and environment sessions could then
use their corresponding records where their actual semantics fit.

Potential benefits are fewer independently maintained capability projections,
explicit authority provenance, and reusable durable state transitions. Those are
hypotheses to test, not guarantees that existing security, retry or recovery bugs
would disappear. Formal properties apply to the model and its assumptions; host
adapters, process lifetimes, native RPC seals and browser origins need their own
proofs.

The costs include mapping Kinu's existing policy without widening authority,
writing real Cloudflare/Nimbus adapters, preserving hot-path execution costs,
and proving that replacing a particular implementation improves it. No universal
per-effect ledger, second policy catalog or duplicated UI system is justified
solely to resemble agent-core. The current product remains the baseline.

## Acceptance status and next decision

**Implemented/local-verified:** authored React TSX and JavaScript/JSX clients,
TypeScript/JavaScript fetch servers, CSS compilation, real workspace file
bindings, source commit/history/fork/restore, restart/reopen and live source
refresh, browser preview-origin isolation, and caller filesystem/role regression
cases. Local browser evidence used the production artifact under local workerd,
not a static gallery as a substitute for server execution. Native facet dispatch
and compiler group isolation have separate workerd regressions.

**Not claimed:** an authenticated production browser-cookie trajectory, completion
of the vendored publication/deployment/resource/skeleton surface, a release-lane
replacement, a general agent-core View/Facet runtime, or formal verification of
Kinu's hosting adapters. Production CLI-authorized acceptance and signed-preview
checks must be reported separately from browser-cookie authentication. Staging
acceptance is deferred by the user's current direction.

For any further adoption, select a concrete existing subsystem, compare its
observable transitions to the candidate agent-core implementation, exercise the
candidate against those obligations, and decide from that evidence. This document
records that option; it does not authorize a sequence of rewrites.
