# Harness profiles

A harness profile is the shape an agent sees: the names and descriptions of
its tools, the prompt that opens its context, the layout of the events and
reminders spliced into it, and the wire format that carries all of it. Kinu
has one profile today, its own. This document lays out the architecture for
several, in steps, so that a user can choose between `native` (what Kinu
writes) and a vendor profile (what Claude Code, Codex or pi write) and the
agent then sees the translated prompts, events, context and tools. The idea
and its first implementation are the owner's `oh-my-tau`
(`packages/coding-agent/src/harness/` in that fork); the reading below is
against its tip `05833b9ee8` and Kinu `main` at `1cdae25d6`, both 2026-09-21.

Nothing here past step 0 is built. Step 0 is what the tree already holds, and
the reason the rest is possible.

## The one invariant

**A profile is a presentation over one canonical record.** The transcript, the
working context, the tool ledger and every reader of them (search, forks,
compaction, evolution, the chat pane, the CLI) store and read Kinu's own
names, schemas and message shapes. A profile is applied at the request
boundary, where the model-visible array is assembled, and reversed at the
response boundary, before anything is recorded. Two consequences follow, and
both are the design:

- A user can switch profiles mid-conversation. The next step re-projects the
  whole model-visible history under the new profile; nothing durable changed.
- Every gate, eval and read model keeps measuring one thing. A profile that
  leaked its wire names into `conversation_entries` would fork every reader.

The projection is deterministic and pure over its inputs (the canonical
messages, the profile, the model), so a stable prefix stays stable: the cache
work of `CACHE-01` is not undone by a profile, and the cache statistics are
reported per profile so a regression there is visible.

## The four surfaces a profile shapes

| Surface | What Kinu holds today (step 0) | What a profile changes |
|---|---|---|
| Prompt | 30 sections defined with `definePromptSection` (`packages/core/src/prompting/section-templates.ts`), prose in `packages/core/src/prompts/*.md` with typed slots (`TemplateSlots`, `packages/core/src/prompting/template.ts`), composed in order by `buildSystemPromptSync` (`packages/core/src/prompt.ts`); a per-family delta file beside a section (`operating-guidance.gpt.md`, `lead-brief.gpt.md`) selected by `promptFamilyDelta` | Which text opens the context (a vendor prompt as block 0, Kinu's sections that are environment facts demoted to block 1, the rest dropped or rewritten in the vendor's voice) |
| Tools | The eight native names in `BUILTIN_TOOLS` with their reach in `TOOL_REACH` (`packages/core/src/tools/registry.ts`), each an AI SDK `tool()` over a `jsonSchema()`; `agents` actions and fields typed and gated (`gate:agents-fields`); crafted tools in their ledger; outcomes typed as `ToolOutcome` (`packages/core/src/types/tool-outcome.ts`) | The wire identity of each tool (name, description, schema) and the set of facade tools the vendor's own agents expect (`Agent`, `SendMessage`, `WebFetch`; `spawn_agent`, `wait_agent`) implemented over the native ones |
| Serialization | The canonical store (`packages/core/src/session`) records the AI SDK's own `ModelMessage` through its own schema, whole (`message-codec.ts`: what goes in comes out, tool calls, results, reasoning and attachments included); portable tool-call ids (`packages/core/src/providers/tool-call-id.ts`); one `ModelProvider.createModel` seam to every vendor (`packages/core/src/providers/types.ts`), the AI SDK owning the wire | The request's namespaces and part shapes where a vendor reserves them (Codex's `collaboration` group), and the mapping of a wire tool call back to the native call it stands for |
| Events and dynamic context | Typed `DynamicContext` sections woven as delta blocks against a frozen tail (`packages/core/src/prompting/volatile-context.ts`); turn-local context; step injections (`step-injections.ts`) | The envelope each block is rendered in (Claude Code's `<system-reminder>`, Codex's developer messages, pi's plain user turns) and where in the step it lands |

The fourth surface is Kinu's own addition to the fork's three. The fork's
profiles shape the prompt, the tools and the wire; Kinu also owes the model
its background events, its plan and its device state as blocks, and a vendor
profile that renders those in Kinu's envelope would read as foreign inside an
otherwise faithful presentation.

## How the fork does it, and what carries over

`oh-my-tau` resolves a `HarnessProfile` (`claude-code | codex | pi`) from the
model catalog, with a `harness.mode` setting of `native | auto | <profile>`
that forces or disables it. Three pieces carry over unchanged in shape:

- **The manifest.** A table per profile from native tool name to wire name
  (`bash → Bash`, `eval → exec`, `glob → find`), where an omitted row means
  "keep the name". A facade presents a registry tool under the wire identity
  as own properties and forwards everything else to the live tool, so the
  schema and the argument handling never fork.
- **The capture.** A vendor prompt and its tool declarations are recorded
  from a real vendor client's request, under a versioned schema, keyed per
  model; the served prompt is block 0 and the harness's own template moves
  to block 1 carrying environment facts only. `pi`'s prompt ships bundled
  rather than captured. Declarations are normalised across `input_schema` and
  `parameters` to one reader shape.
- **The boundary.** The effective profile is read at the tool-presentation
  layer, the prompt layer and the wire layer from the same setting, never
  captured earlier, so a setting change takes effect on the next step.

Two things do not carry over. The fork's tools map one to one; Kinu's `file`
is one tool with three actions where Claude Code declares `Read`, `Write` and
`Edit`, and `agents` is one tool with five actions where both vendors declare
several. A Kinu facade is therefore a projection, one native tool to N wire
tools and N wire calls back to one native call, not a rename. And the fork
records only what the model said and did under the wire names; Kinu records
the native call, which is what makes the invariant above hold.

## The profile axis

```
HarnessProfile = 'kinu' | 'claude-code' | 'codex' | 'pi'
HarnessMode    = 'native' | 'auto' | HarnessProfile
```

`native` is today's behaviour and stays byte-identical: the pin for step 1 is
that a `native` run's prompt-prefix digest equals the digest before the axis
existed. `auto` resolves the profile from the model the way `resolveFamily`
(`packages/core/src/prompting/model-profile.ts`) resolves the prompt family
today, extended by one column in the same place: a `claude` family defaults to
`claude-code`, `gpt` to `codex`, everything else to `kinu`. A named profile
forces that surface onto any model. The mode is a workspace setting the owner
changes from the UI and the CLI, read at every step and never captured.

## Steps

0. **Done.** Prompts are typed data with per-family deltas; tools are one
   typed registry with declared reach; the canonical store keeps native
   messages whole through the SDK's own schema; dynamic context is typed
   sections. This is the starting point the owner asked for and it is on
   `main`.

1. **The axis.** `HarnessProfile`, `HarnessMode`, the setting, the resolver
   beside `resolveFamily`, the mode carried into the run record and the
   prompt-prefix telemetry so cache figures read per profile. No behaviour
   changes under any mode: the pin is the byte-identical prefix. Small, and
   the first thing to land because every later step reads it.

2. **Tool presentation.** A manifest per profile in `packages/core/src/tools`
   beside the registry: for each native tool, the wire tools it presents as
   (name, description, schema) and the two projections, request-side (native
   declarations to wire declarations) and response-side (a wire call to the
   native call and arguments it stands for). Applied in `composePrepareStep`
   (`packages/core/src/prompting/prepare-step.ts`) over the declarations and
   the model-visible history, so prior calls in the context render under the
   same names the model can call. The canonical record stays native. Gates:
   the projection round-trips every native call for every profile; `native`
   is the identity; `gate:agents-fields` extends to the facade fields.

3. **Prompt presentation.** A prompt source per profile: a bundled text for
   `pi`, a recorded capture for `claude-code` and `codex` under the fork's
   capture schema, served as block 0, with Kinu's sections partitioned once
   into "environment facts" (kept as block 1, in the vendor's envelope) and
   "operating doctrine" (dropped, because the vendor prompt carries its own).
   The partition is a property on each `definePromptSection`, so it is data
   and GEPA still sees every section. Cache breakpoints
   (`packages/core/src/prompting/cache-breakpoints.ts`) move with block 0.

4. **Events and dynamic context.** One renderer per profile over the same
   `DynamicContext` sections and step injections: the envelope, the position
   in the step, and the vendor's own vocabulary for a plan, a task list and a
   background result. The delta-block contract (only changed sections
   re-emit; blocks collapse at compaction) is unchanged, since it is a
   property of the sections, not of their envelope.

5. **Wire namespaces and captures.** Codex's reserved `collaboration` group
   and the configurable namespace the fork documents; a capture tool that
   records a vendor client's request the way the fork's does, versioned and
   keyed per model, kept out of the repo and read from the deployment's own
   store; the `harness.mode` control in the workspace settings and the CLI.

Steps 2 to 5 are deferred until the owner opens them. Nothing in steps 0 or 1
is contingent on them, and nothing in them changes the canonical store.

## What this must never do

- Store a wire name, a facade schema or a vendor envelope in the canonical
  store or any ledger. The record is native; the profile is a view.
- Make `native` mean anything but today's bytes.
- Add a second prompt composer, a second tool registry or a second provider
  seam. Each profile is a table and two projections over the ones that exist.
- Ship a recorded vendor prompt in the repository.
