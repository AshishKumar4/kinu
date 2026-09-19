# Capability model

A plan, written 2026-09-13 against `81314a551`. As of 2026-09-18 the record
types below are adopted and the seam they describe is implemented — the
"nothing here is built" header this document opened with is stale. What is
built differs from the plan's agent-core `Grant` records: the live model is
per-member/effect grants cut by `cutShareGrant`
(`packages/core/src/slates/capability-graph.ts`), checked per call by
`grantAdmits` (`packages/core/src/slates/bindings.ts`), with the viewer bounds
and consent page in §3–§4 implemented in `packages/cf-backend/src/slates/host.ts`
and `packages/cf-backend/src/slate-share-route.ts`.

## 1. Decision

Kinu adopts agent-core's capability model and its record types. It does not
adopt agent-core's runtime. The record types are importable from the
digest-pinned vendored package. `packages/agent-core/package.json` exports
`./facets` and `./authority`; they resolve to `packages/agent-core/dist/
facets-public.d.ts` and `packages/agent-core/dist/authority-public.d.ts`.

The types, with their verified shapes:

- `Impact` — `"observe" | "mutate" | "externalSend" | "execute" | "delegate" |
  "administer"` (`packages/agent-core/dist/facets/generated/enforcement/
  AgentCore/Facets/Enforcement.d.ts:11`).
- `OperationDescriptor` — a named operation carrying an `impact: Impact`
  (`.../facets/contribution.d.ts:10`, `:28`).
- `CapabilitySpec` — `facetPattern`, `operations`, `impacts`,
  `argumentConstraints`, with `matches` and `covers`
  (`.../facets/capability.d.ts:7-10`, `:20-23`, `:27`, `:37`).
- `Grant` — `scope`, `subject`, `effect` (allow or deny), `capability`,
  `origin`, `attenuationOf`, `state` (`.../authority/grant.d.ts:18-24`,
  `:35-43`; `GrantEffect` at `:6`).
- `BindingRequirement` — exported from `.../facets/manifest.d.ts`
  (`packages/agent-core/dist/facets-public.d.ts:8`).

The runtime is not adopted. agent-core is version 0.1.0
(`packages/agent-core/package.json`), its surface is spec-normative, it is
hosted on Worker Loader rather than Nimbus, and its grant-resolution engine is
not among the public exports.

## 2. Where impact attaches: one seam

Every Slate binding call is resolved by `routeSlateBindingCall` in
`packages/core/src/slates/bindings.ts`. It returns a `SlateBindingRoute`
(`bindings.ts:85-99`), a union of eight kinds: `namespace`, `codemode`, `tool`,
`rpc`, `mcp`, `agent`, `ai`, `app`. `SlateHost.run` in `packages/cf-backend/src/
slates/host.ts:718` dispatches on `route.kind` (`host.ts:719`, cases at `720`,
`730`, `732`, `736`, `741`).

Impact is derived per route:

- `rpc` read models are `observe`.
- `mcp` reads the server's `readOnlyHint`
  (`packages/core/src/tools/mcp-surface.ts:124`) and maps it to `observe`;
  otherwise the seam floor applies — `externalSend` for a remote server,
  `execute` for a local one. A server's custom agent-core impact annotation may
  only raise the floor, never lower it.
- `tool` and `codemode` members carry a declared `Impact` on the tool registry
  row. `packages/core/src/tools/registry.ts` holds `TOOL_REACH` (`:80`) over
  `ToolReach` (`:60`), which today records `replay: ReplayPolicy`
  (`'safe' | 'claimed'`, `:58`). The declared `Impact` replaces that
  vocabulary — one vocabulary, not two.
- `namespace` members declare impact on their descriptor.
- `app` hops inherit the callee's impact at execution, never the caller's
  claim.

An operation with no declared impact is refused, not defaulted.

## 3. Grants, as built

A live share stores a member/effect grant per binding — `ShareGrant`
(`packages/core/src/slates/sharing.ts`), cut by `cutShareGrant`
(`packages/core/src/slates/capability-graph.ts`) from the slate's declared
bindings restricted to the members the owner approved. `observe`-effect
members admit on the grant alone; anything above — `mutate`, `send`,
`delegate` — requires an explicit owner approval on the row, and the consent
page precedes any viewer on a share whose slate reaches credentialed bindings
(`credentialedBindings`, `packages/core/src/slates/project.ts`). The prompt lists the
exact bindings and members granted and the concrete risk. Owner preview holds
the owner's full authority.

The shared execution capability is the grant re-read per request — the share
row on every admission and every `bindingCall` (`host.ts` `admitViewerRequest`,
`bindingCall`), so revocation is a row state change the next request sees
(S6). Approval reuses `packages/core/src/safety/approval-gate.ts` and the
workspace-capability tables, extended — never a parallel table.

## 4. Capability flow as a DAG

Nodes are principals (owner, viewer, share), slates, bindings and operations.
Edges are `Grant.attenuationOf` — a forest in agent-core — plus Kinu's
`SlateCallerHop` chains (`packages/cf-backend/src/slates/bindings.ts:11-19`),
which record which slate invoked which binding for whom. The DAG is a read
model built from `slate_shares`, `slate_live_shares`, the grants, and the
invocation records `docs/SLATE-SHARING.md` names and the tree implements
(`slate_viewer_requests`, `packages/core/src/slates/live-shares.ts:31`;
`docs/SLATE-SHARING.md:229`). It renders in the sharing UI as "what this share
can reach and through what". No new event stream.

## 5. What changes in code

- `packages/core/src/tools/registry.ts` rows gain `impact`.
- `packages/core/src/tools/mcp-surface.ts` derives impact from `readOnlyHint`.
- `packages/core/src/slates/bindings.ts` `routeSlateBindingCall` returns the
  route with its impact.
- `packages/cf-backend/src/slates/host.ts` `SlateHost.run` checks the caller's
  grant against the impact before dispatch.
- `packages/core/src/safety/approval-gate.ts` learns the impact-tailored
  prompt.
- Schema adds grants keyed by share.

Deleted: replay `safe`/`claimed`, once impact covers it. Kept: Nimbus hosting,
the `SlateBinding` entrypoints, the egress gates.

## 6. Unknowns
- agent-core's MCP facet ignores `readOnlyHint`, so Kinu's derivation is its
  own.
- `agent` and `ai` routes carry no declared impact, so this model refuses
  them; a grant that should admit one needs a rule first.
- Argument constraints are not applied in phase 1.
- The approval-gateway facet in agent-core was not read.
