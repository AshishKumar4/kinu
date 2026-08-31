# Kinu — Agent Development Guide

## Project Overview

Self-evolving agent framework with MCTS parallel exploration, mutable scaffolding,
and durable skill evolution. Two backends: Cloudflare Workers (AIChatAgent + DO) and
local CLI (bun:sqlite). Shared core with abstract interfaces.

Monorepo with `bun` workspaces: `packages/*`.

## Build & Check

```bash
bun install                              # install all dependencies
bun run check                            # strict lint + TypeScript type-check
bun run lint                             # strict Oxlint + anti-slop rule contracts
bun test --cwd packages/core             # run all unit tests
bun test packages/core/tests/unit-*.test.ts  # run only unit tests
bun test tests/e2e-lifecycle.test.ts     # run E2E tests (needs LLM credentials)
bun run dev                              # Vite dev server (cf-backend)
bun run layergate                        # per-layer regression report (no LLM)
bun run layergate --matrix               # fault-injection localization matrix
bun run layergate:lock                   # re-lock after an intended change
bun run deploy                           # production deploy (scripts/deploy.sh)
bash scripts/setup-worktree.sh           # prepare a git worktree (see below)
```

`bun run check` runs the strict lint gate before TypeScript. All anti-slop rules are
errors, warnings fail the gate, and unused disable directives are errors.

**A gate is only worth the set it actually measures, and four here have been green while
blind.** `gate-set-equality`'s import resolver returned nothing for an extensionless specifier,
silently shrinking the governed set; `layergate` carried the same bug; `capability-parity` carried
a dead `.jsx?` strip; and `sources.ts` applied `.gitignore` on top of `git ls-files`, so a file
that was tracked AND ignored was invisible to every gate built on it — including the secret
scanner, which passed over two live credentials. None of those failed. They passed, over less than
they claimed. So when adding or trusting a gate: state the set it MEASURES and the set it claims
to GOVERN and check they are equal; read the corpus through `scripts/sources.ts`, never a
hand-maintained list beside it; prove it RED in every direction it claims before trusting it
green; and print its own blind spots on the SUCCESS path, because a limitation visible only in
red output is invisible exactly when the tree is green.

**A red gate is work, never an obstacle. Nothing here is ever made to pass by making it weaker.**
That means all of: no `--no-verify` and no `core.hooksPath=/dev/null`; no `oxlint-disable` on any
rule, not only the four catch ones; no ignore-list or allowlist entry added so a check stops seeing
something; no rule downgraded from error to warning; no assertion narrowed, no failing test deleted
or skipped, and no timeout raised until a wait succeeds — a longer wait on a selector that will
never appear takes twice as long to lie. When a gate goes red, exactly one of two things is true:
the code is wrong, or the gate's own fixture is stale. Find out which and fix that one. If you
conclude the RULE is wrong, that is a decision to surface with evidence, never to take while
clearing your own path.

**And a gate that runs but can no longer fail is worse than a red one, because it reads green.**
Three arrived that way in one day: `unitWords` kept running after every claim that could trigger it
was deleted; a citation test's live fixture and its absent fixture became the same string once the
rename it anticipated actually landed, so its stale-citation direction silently could not fire; and
a bench defect was retired rather than re-pointed at the surviving code that still had the property
it encoded. Each was recorded honestly and left, which is how a suite keeps its count while losing
its teeth. So: when a fixture stops being able to fail, restoring its red direction is part of the
same change, not a follow-up. Retiring a corpus entry is legitimate only after establishing that no
live code still holds the property — say what you searched.

**A verification claim must match what was exercised.** Beyond the `node_modules` trap below: a
suite run in a shared checkout proves nothing about your branch (green may be someone else's
in-flight work, red usually is), a number recalled is not a number measured (a platform limit was
once asserted here against a value that had not existed for ten months), and a subagent's summary
is a claim to check, not evidence. Say which tree, which command, and which revision.

The anti-slop plugin is **vendored**, not a dependency: upstream
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) is `private: true` and publishes no
npm package. `tools/oxlint/anti-slop/upstream.json` pins the upstream commit and a digest per
vendored file, and `drift.test.ts` fails naming any file that diverged. Three rules are
deliberately stronger than upstream and are declared there with their reason; changing one fails
the gate rather than passing as a sync. To take a newer upstream:

```bash
git clone https://github.com/dmmulroy/anti-slop /tmp/anti-slop
# merge upstream's rules/ and src/rules/*.test.ts into tools/oxlint/anti-slop/, keeping the
# declared local deltas, then re-pin:
ANTI_SLOP_UPSTREAM=/tmp/anti-slop node --experimental-strip-types \
  tools/oxlint/anti-slop/drift.test.ts --update
bun run test:anti-slop
```

## Working In A Git Worktree

A fresh worktree has no `node_modules`. **Run `bash scripts/setup-worktree.sh` in
it — once — before anything else.**

Do NOT symlink or copy the main checkout's `node_modules` wholesale. Everything
inside it, the workspace scope included, then resolves through the main checkout, so
`@kinu.run/core` is *main's* core: cross-package tests and `bun run check` run
green against source nobody edited, and the branch under test is never loaded.
That has silently cost us a bench run (solver edits graded as if never made),
the harbor adapter, and a week of agent worktrees.

The script links third-party dependencies per entry and gives the tree its own
real `@kinu.run/` scope directory pointing at its own `packages/`. It refuses to
run when the branch changed `bun.lock` — run `bun install` in the worktree then,
because borrowed modules would be the wrong ones.

The invariant is enforced, not just documented: every package's suite carries
`tests/workspace-resolution.test.ts`, which fails loudly with the fix command
whenever `@kinu.run/*` resolves outside the tree it is running in
(`packages/test-utils/src/workspace-resolution.ts`).

**Agents and delegated sessions NEVER edit the primary checkout.** Work in a
worktree — an existing one for your branch, or a fresh one via the script
above. Eight stray-edit incidents in one day came from one mechanism: a
repo-relative `edit`/`write` path resolves against the SESSION cwd (the
primary checkout) and reports success while your worktree stays untouched.
The nastiest variant: a `read` with an ABSOLUTE worktree path followed by an
edit whose section header is the RELATIVE spelling — the tag matches, the
edit lands in the primary, no error anywhere. So:

- Every `edit`/`write` path is absolute, under YOUR worktree, and an edit's
  section header carries the SAME absolute path the tag was read from.
- After the first edit of any file, `git -C <your-worktree> status` must show
  it changed; if `git -C ~/Kinu status` shows your file instead, stop,
  extract your diff with `git diff -- <paths>`, apply it in your worktree,
  and revert the primary path-scoped. Never a bare checkout or reset there —
  other agents' work may be in flight beside yours.

Parallel writers use isolated worktrees and make focused commits. Main merges
and verifies those commits before updating `origin/main`.

A fresh worktree whose branch changed `bun.lock` needs its own `bun install`,
and that install needs the security scanner's own imports resolvable before
anything is installed — the script pre-seeds them; do not delete that step.

Branches get pruned; the `archive/*` tags are what make that safe. Before deleting
anything under `refs/tags/archive/`, read [docs/BRANCH-ARCHIVE.md](docs/BRANCH-ARCHIVE.md).
The inventory there is the count, and every tag in it currently carries blobs no
other ref reaches. No test or gate fires when a tag disappears.

## Deploy Discipline

- `bun run deploy` (`scripts/deploy.sh`) is the only production deploy path. Never deploy production with a bare `wrangler deploy` — it skips the CLI-download asset check and the post-deploy smoke gate, and production has shipped assetless that way (every fresh install died on a checksum mismatch while the site looked fine).
- One assets directory: `packages/cf-backend/dist/client`. `dist/kinu/assets/` is the Worker's code-split chunk output, not an assets dir — nothing written there is served. See docs/DEPLOYMENT.md § Static assets.
- `GET /api/health` reports `{version, sha, builtAt}` for the deployed build, read back out of the asset bundle. Check it after any deploy or rollback; `ok: false` means the asset half did not land.
- **The Worker's gzip bundle is the binding build budget, and it is measured, not assumed.** After a vite build, `bunx wrangler deploy --dry-run` in `packages/cf-backend` prints the authoritative `Total Upload / gzip` figure the deploy API enforces — Vite's per-chunk `gzip:` line covers one chunk and understates the total by more than 2x. Three readings, same method: **6,254.64 KiB on 2026-08-04** (spike branch, Nimbus 0.1.x), **6,983.03 KiB on 2026-08-18** (`17318b3f`, Nimbus `worker@0.2.3`), and **7,091.83 KiB on 2026-08-19** (Nimbus `core@0.5.0`/`worker@0.3.0`, every Nimbus patch dropped and `@nimbus-sh/fabric@0.1.0` newly in the graph). A fourth reading: **7,138.34 KiB on 2026-08-20** (`a38d2b73`, pins unchanged) — +46.5 KiB over its own-day baseline of 7,091.83, attributed by measuring both sides of one commit: the `@kinu.run` scope rename lengthens every specifier that survives into the bundle. One trap this section has already caught once: the dry-run only measures a FRESH build — `dist/` from an earlier build measures identically forever, and cf-backend has no `build` script, so the build step is `bunx vite build` (with `CLOUDFLARE_ENV` for staging), never `bun run build`. Against the paid **10 MB** gzip cap that is roughly **69% consumed, ~3 MB free**; raw upload 27,471 KiB against the 64 MB pre-compression cap is not close. The third reading is what makes the second interpretable: the 0.2.x→0.3.x major bump plus a whole new package cost **+109 KiB**, so the earlier **+728 KiB** was overwhelmingly main's own growth rather than the Nimbus pin, which is the split that reading could not perform. Most of the floor is structural: `server.ts:85-95` re-exports `NimbusSession` plus eight sibling Nimbus entrypoint classes, and an exported entrypoint cannot be tree-shaken, so the Worker pays for Nimbus's whole session machinery whether or not a request touches it. Re-measure on both sides of anything that adds a dependency, a DO class, or top-level work. A Worker over the cap fails validation at upload — the same shape of failure as the assetless deploy above, where the site looks fine
  A fifth fresh-build reading is **7,259.24 KiB on 2026-08-24** (`feat/profiles-tui`, after final review). The raw upload is **27,965.43 KiB**. The ControlPlaneDO, three Analytics Engine datasets, feedback flow, profile routing, and UI changes add **120.90 KiB gzip** over the 2026-08-20 reading. The bundle uses **70.9%** of the paid 10 MB cap.
  A sixth fresh-build reading is **7,599.06 KiB on 2026-08-28** (`consolidate/final-history` at the ten-subsystem integration commit). The raw upload is **29,041.97 KiB**. The terminal-durability spine, candidate control plane, device-ownership jobs, and the profiles/TUI integration add **339.82 KiB gzip** over the 2026-08-24 reading. The bundle uses **74.2%** of the paid 10 MB cap, ~2.5 MB free.
- Startup time is **not** the constraint: **185–252 ms, measured 2026-08-04** against Cloudflare's startup limit of **1 second**, about a fifth of it. The limit was raised from 400 ms on 2025-10-10, so **do not cite 400 ms**. The spike write-up that compared against the old 400 ms limit is deliberately out of this repository (it went with the other internal design records), so the two bullets here are the evidence for both budgets, each carrying its own date. Re-measure rather than re-deriving either figure from memory

## Commit Messages

`bun run gate:commit-message` and `.githooks/commit-msg` enforce this. Both run the same program, `scripts/commit-hygiene.ts`, which states the vocabulary in its own failure output — so this section is a convenience, and `scripts/commit-hygiene.test.ts` asserts the two agree rather than letting them drift.

- **A subject is `type: text` or `type(scope): text`, at most 80 characters.** `type` is lowercase and one of: `fix` `feat` `docs` `bench` `test` `refactor` `chore` `cli` `core` `mcts` `cf` `gate` `heads` `eval` `evolution` `prompt`. Those sixteen are every token used 13 or more times across the 1,610 non-merge subjects of the pre-convention history; the other 171 were used fewer, and a component name belongs in the parens (`fix(layergate): …`) rather than in front of the colon. The ceiling is the largest round number at or below the measured p90 of 82. Git writes its own subjects for merges, reverts and autosquash, and those are exempt.
- **Never name a subagent.** Every commit here is authored under one person's name, so `Main's ruling` or `FixtureZero's findings` reads as him crediting a colleague who does not exist. Nine such names reached the permanent record before the gate existed. State what changed and what proves it.
- **Never credit the requester, and never treat a session as a unit of work.** `the owner asked for this`, `the owner was right`, `per the owner's instruction`, `the owner's floor-continuation question`, `shipped this session`, `before this session` — all facts about a work process rather than about the code, and all permanent. **The owner as a modelled ENTITY is fine and is not gated**, because it is one: `the owner's UserDO`, `spend the owner's inference credentials`, `emails the owner on failure`, `runs as the owner on the owner's machine`. Same for a live session object: `this session owns the local clock`, `this session's delegation deps`. The rule follows the act, not the word — `the owner` appears in 119 tracked source files and gating the bare phrase would fail correct sentences.
- **No first person.** No `I`, no `my`, no argument with a previous position (`my earlier claim was wrong`, `as requested`). The Author field records who wrote it. If a previous commit's claim was wrong and has not shipped, amend it.
- **Bodies are welcome and usually earn their place** — a measured number, a rejected alternative, a non-obvious why. The audit that produced this convention found the long bodies here justified far more often than not. Length is not the defect; the four rules above are.
- The four prose rules skip quoted spans, inline code, fenced blocks and indented lines, so a commit may quote a shipped product string verbatim even when that string itself contains a governed phrase.
- Four things the gate deliberately does NOT judge, and prints on its green path so nobody reads green as "well written": colon-reveal subjects, binary contrasts, em-dash density, and sentence length. All four are real and all four have legitimate instances, so they stay review criteria.

## The Requests Ledger

`docs/research/REQUESTS-LEDGER.md` holds every request made in
conversation, with the state last verified and the command that verifies it. A
row is DONE only when its command passes. A row with no verifying command is
UNVERIFIED and counts as open. It exists because an audit found four requests
that were designed, discussed, built and never wired, and memory was the
tracking mechanism. Read it before claiming a request is closed, and add a row
when a new one arrives. The ledger was moved off the public tree into
gitignored, machine-local `docs/research/`.

## Working Style

- Avoid loading skills unless they are concretely needed for the task. Keep context focused and prefer direct source inspection for routine repo work.
- User responses lead with the conclusion, use plain language, and include only decision-relevant detail. Keep them within two rendered pages unless the user explicitly asks for depth.
- Code reviews, quality audits, and pre-merge review passes MUST load the `thermo-nuclear-code-quality-review` skill and apply its approval bar. This binds the reviewer and every dispatched reviewer/audit subagent; name the skill in their briefs.

## How To Write Docs, Write-Ups, Descriptions, READMEs

The owner's instruction, verbatim:

> And ensure everything passes through the no-ai-slop skill, and is write it in ASD-STE100 or simplified technical english. And follow Zinsser's four principles of quality writing:
> 1. Simplicity
> 2. Brevity
> 3. Clarity
> 4. Humanity

This governs every `.md` in this repository, every docstring a human reads for orientation, every
model-facing prompt string, every commit body, and every changelog entry.

- **Run the `no-ai-slop` skill on the text before it lands.** It is the standard, not a polish pass.
  Its banned words (`delve`, `leverage`, `robust`, `seamless`, `transformative`, `harness`, and the
  rest), its cut patterns and its em-dash rule all apply. The patterns that catch this repository
  most often: binary contrasts ("not X, it's Y"), colon reveals, faux-insight setups ("what most
  people miss"), importance puffery ("marks a pivotal moment"), fake-profound closing lines, and
  summary-recap endings.
- **Write ASD-STE100 Simplified Technical English.** One idea per sentence. Active voice. Present
  tense. One meaning per word, and the SAME word every time for the same thing — synonym cycling is
  forbidden here for the same reason it is forbidden in code: two names for one concept is how a
  reader learns to distrust both. At most 20 words in a description, 25 in a procedure step. No noun
  cluster longer than three words. State the condition before the instruction.
- **Zinsser's four, in his order, because the order is the priority.** Simplicity: cut every word
  doing no work. Brevity: the shortest version that keeps the meaning. Clarity: the reader gets it
  on one pass. Humanity: it sounds like a person who cares, not a company.

One convention this repository already had, and it survives: user-facing prose is in the owner's own
first-person voice.

**Docs here carry no AI-edited disclaimer line.** 31 of the 32 tracked `.md` files carried one until
2026-08-20, when the owner removed the convention. Two generators printed it and no longer do:
`packages/cli/src/cli-reference.ts` (which writes `docs/CLI.md`) and `scripts/platform-catalog.ts`.
Do not add the line back.

Where Simplified Technical English and readable English pull apart, the reader wins — keep the STE
discipline that carries the weight (one idea, one word per meaning, active voice, short) and drop
the letter of a rule that makes a sentence worse.

**One rule specific to this codebase.** A doc here states what was MEASURED, with the number and
the date, or it says the number is not measured. A prose figure nobody can reproduce is the defect
this repository keeps finding in its own gates, and it is worse in a doc, because a doc has no test.

**One name per referent, and the referent decides the name.** A swarm's agent is a **swarm node**,
or a bare **node** once the context has established it. It is never a "search node", because
`search_nodes` is a TABLE and a row in it is a tree vertex the engine writes, not an agent with a
turn loop, a home and a credential. Two similar names for two different kinds of thing is worse
than one long name for one of them: a reader who meets both has to work out which is which, and the
answer is not guessable from either. The table identifier stays `search_nodes` — identifiers never
change for prose reasons, and prose about a row may say so.

Review document claims against code before they land. Verify named symbols, paths, and counts against
source. Keep figures dated and tied to a measurement. A banned phrase has no code side. Review it
instead of adding a word-list check.

## Package Structure

```
packages/
  core/         @kinu.run/core — abstract interfaces, MCTS, evolution, scaffold, craft
  cf-backend/   Cloudflare Workers backend — Think DOs, React UI, Vite+Wrangler
  agent-utils/  MemoryStore, CraftStore, VFS types, addressing, walk, encoding
  cli/          CLI frontend (commander-based)
  cli-backend/  CLI-specific backend (bun:sqlite, Node vm)
tests/          E2E tests (run from repo root)
bench/clbench/  Kinu as a system for the external Continual Learning Bench
```

### cf-backend Architecture

- `OrchestratorAgent extends ActorAgent` — chat, built-in tools, evolution hooks
- `SubordinateAgent extends ActorAgent` — a persistent helper facet sharing workspace files with actor-private shell/scaffold state
- `ExplorationAgent extends Agent` — a toolless MCTS rollout or tool-using head via Facets
- `runtime.ts` — `createCFRuntime()` bridges Think DO context to `AgentRuntime`
- `wrangler.jsonc` — DO bindings, worker_loaders, AI Gateway, SPA assets
- `ControlPlaneDO` — the singleton admin index, feedback queue and audit log
- Analytics Engine bindings — fleet metrics only; exact agent state stays in each owning DO
- `vite.config.ts` — cloudflare() + react() + agents() + tailwindcss() plugins
- React UI uses `useAgent()` + `useAgentChat()` from agents/react, @cloudflare/ai-chat/react
- `wrangler dev` (via `vite dev`) runs everything locally with real DOs and SQLite

### Core Subsystems (packages/core/src/)

| Directory    | Purpose                                                 |
|-------------|----------------------------------------------------------|
| identity/   | Workspace creation, reopening, soul (user-editable purpose), DDL |
| evolution/  | 4-timescale auto-evolution engine, tool building         |
| mcts/       | Monte Carlo Tree Search — UCT, backprop, convergence     |
| scaffold/   | Agentic loop versioning — bootstrap, modify, rollback    |
| craft/      | Tool quality store — EMA scoring, discovery, conflict    |
| execution/  | Multi-executor routing: workspace, sandbox, laptop, parent |
| types/      | TypeScript interfaces for all primitives                 |
| utils/      | nanoid, date helpers                                     |
| layergate/  | Per-layer deterministic regression gate over the turn pipeline |

## Execution Layer

Each environment is a codemode `ExecutorProvider` with namespace.* APIs.
`workspace` is the one authoritative file and execution plane: on the hosted
backend it is the workspace's `NIMBUS_SESSION`, and on the CLI it is the local
workspace. Optional sandbox and laptop rows are genuinely different machines
with their own native paths. The workspace plane carries a MOUNT TABLE
(`core/src/vfs/mounts.ts`): a live device's files appear at `/pc`, a bound
container's at `/sandbox`, served through the owning executor's own `files`
VFS with every boundary it enforces (device consent) intact. The mount table
extends the one view; there is no second Nimbus executor or filesystem, and no
copy of workspace bytes behind a mount point. The workspace shell does not see
mount points — commands reach other machines only through their namespaces.
Memory indexing and fork snapshots address the base tree alone.

| Executor   | Namespace  | Binding Required          | Capabilities                |
|-----------|------------|---------------------------|-----------------------------|
| Workspace | workspace  | NIMBUS_SESSION on hosted  | canonical files, POSIX shell, ~95 coreutils, `node`; `npm`/`npx`; on-demand `bash`, `python3`, `pip` locally; `git` and `bun` on hosted only; processes, ports |
| Container | sandbox    | Sandbox DO + Container    | Linux container: git, npm, node, bun, sh/bash, jq, curl; long processes, inbound ports, previews. Probed ABSENT: docker, python3, make, gcc, clang, tsc |
| Device    | laptop     | WebSocket tunnel from user| the user's own machine, behind consent |
| Parent    | parent     | (forks only)              | the forked-from workspace's real shell over DO RPC |

Which of those a given session may claim is not a matter of taste: the
capability set is rendered into the agent's own execution block
(`prompting/volatile-context.ts` — `— runs: …`), so it is where the model
decides to send work. Hosted workspace runtimes come from the bound
`NIMBUS_RUNTIME_CACHE`; local runtimes come from npm packages
(`vfs/workspace-runtimes.ts`). A runtime still reports unavailable when its
package is absent from the cache.
`sh`, `make`, `tsc` and `jq` exist on neither workspace path. When to leave the
workspace for the container, and why "I need Python" is not a reason:
`docs/EXECUTION-LAYER-SPEC.md`.

`DefaultExecutionRouter` manages providers. `runtime.ts` registers them based on
available bindings. `getProviders()` filters to available-only for `createExecuteTool()`.

## Key Interfaces

- `AgentRuntime` — single struct combining all primitives (types/agent-runtime.ts)
- `SqlExecutor` — tagged-template SQL (types/primitives.ts)
- `VFS`, `Memory`, `Executor`, `LLM`, `Schedule`, `Identity` — six abstract primitives
- `ExecutorProvider` — codemode sandbox participant (execution/types.ts)
- `ExecutionRouter` — manages executor providers (execution/types.ts)
- `CraftStore` — persistent tool storage with EMA scoring

## Code Style

- TypeScript strict mode, ES2022 target, ESNext modules, bundler resolution, `verbatimModuleSyntax`
- **Relative imports carry NO extension.** `import { x } from './thing'`, never `'./thing.js'` and never `'./thing.ts'`. Nothing here emits: every project is `noEmit`, there is no `outDir`, and all three runtimes read the TypeScript directly — Vite/wrangler bundle the Worker, Bun runs the CLI and the suites from source, the deploy ships a CLI source archive. So there is no `.js` file for a specifier to name, and `.ts` is redundant where the resolver already finds it. `tsconfig.base.json` omits `allowImportingTsExtensions` so a `.ts` specifier is a type error, and `anti-slop/require-runtime-import-extension` rejects both spellings
  - **One exception, and it is enforced, not honoured.** `tools/oxlint/anti-slop/**` plus `scripts/sources.ts` run under raw `node --experimental-strip-types` (oxlint's `RuleTester` needs Node's raw transfer and throws under Bun), and Node's ESM resolver takes a complete path — no extensionless specifier, no directory index. Those files keep explicit `.ts`. `import-extension.gate.test.ts` recomputes that closure from the entrypoints and fails if it stops matching, so the exception cannot quietly widen
  - An extension is correct only when it names a file that is really there: `.json` data, the `.mjs`/`.cjs` test fixtures, and `packages/pc-agent/src/index.js`, which is a genuinely CommonJS package
- Tagged-template SQL via `SqlExecutor` for parameterized queries
- `RawSqlExec` (plain string) only for DDL (CREATE TABLE, CREATE INDEX)
- All DDL uses `IF NOT EXISTS` — schema init is idempotent
- Vercel AI SDK v6: `tool()` + `jsonSchema()` for tool definitions
- `ToolSet` type from `ai` package for tool collections
- **The AI SDK is not a preference and replacing it is not an option** — asked and answered 2026-08-17, do not reopen without new evidence. `ai` is a REQUIRED peer of `@cloudflare/think` (only `@ai-sdk/react`, `@chat-adapter/telegram`, `react` and `vite` are optional there), `ActorAgent extends Think<Env>`, and every override point is SDK-typed: `getModel(): LanguageModel`, `getTools(): ToolSet`, `beforeTurn(TurnContext{ModelMessage[], ToolSet, LanguageModel})`, `TurnConfig.stopWhen: StopCondition<ToolSet>`. Think does not merely import it — `think.js:7` does `import * as aiSdk from "ai"`, `:301` feature-detects `"registerTelemetry" in aiSdk`, and `:2827` calls `wrapAISDK(aiSdk, …).streamText`, so it branches on which MAJOR of `ai` is installed at runtime. Nor is the CLI the cheap side to swap: `cli-backend/src/local-session.ts:63` drives `runChat` from `@kinu.run/core`, which IS `core/src/chat.ts`, and core holds 54 of the 86 SDK source files. Plus ~1,423 lines of `LanguageModelV2` implementations (`claude-cli-provider.ts`, `opencode-provider.ts`, `providers/codex.ts`) exist only because an SDK model is BEHAVIOUR; alternatives model it as data. Reasoning of record: maximum code reuse across backends, with most logic in core. Full audit: `docs/research/sdk-dependency.md` (gitignored)
- `@earendil-works/pi-*` is a BENCH SUBJECT only (`scripts/bench-pi-worker.ts`), never a runtime dependency. Ideas may be borrowed with citation; a second AI stack may not be added. **Two different codebases have been cited under one name — keep them apart.** `@earendil-works/pi-*` is UPSTREAM **pi** (Mario Zechner), which ships no sub-agents at all (its `README.md:500`: "**No sub-agents.** … Spawn pi instances via tmux, or build your own with extensions"), so nothing about delegation may be attributed to it. **oh-my-pi** is `can1357/oh-my-pi`, a hard fork at 17.3.7, and it is the source of the `hashline` and `task`-`context` citations
- `@callable()` decorator for RPC methods exposed to the React UI
- A tool that cannot do what it was asked answers with a CLASS, never with prose alone: `{ reason: ErrorCode, error: string }`, reason first. `KinuError`/`ErrorCode`/`toKinuError` in `@kinu.run/core/obs` build it, `refusalText` (`execution/exec-result.ts`) puts it on the string channel every executor tool answers on, and `read-models/tool-failures.ts` is the reader that branches on the class. All five executor tools are converted — `sandbox`, `nimbus`, `parent`, `device-tunnel-executor`, `inline` — so a returned `exec error: …` string is now a regression, not a convention to copy. The residue is listed and reasoned in [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) § "What is NOT converted"; `neverthrow` was REJECTED with evidence and must not be added — see § "Why not neverthrow"
- Executor tools use positional args (`positionalArgs: true`) for codemode
- No elapsed LLM, turn, delegation, swarm or compaction deadline. Work ends on provider completion, a definitive failure, or explicit cancellation. Provider rate limits use unbounded capped-backoff retry until cancellation.

## Errors, Logging & Traceability

No `catch` may discard its error. `catch {}`, `catch { return null }` and `catch { return [] }` are defects: a read that answers `null` for "absent" and `null` for "the query blew up" is how `workspace_capability` stayed invisible for months. Every catch does exactly one of three things:

1. **Do not catch.** The default, and usually the fix — deleting the `try`/`catch` is a real change.
2. **Wrap and rethrow** — `throw new Error('what we were doing', { cause: caught })`. Native `cause` is the language's `%w`; the chain must never be broken.
3. **Handle, and say so.** Only when the caught condition is a *value* in the domain. Record the caught error and return something the caller can tell apart from success.

- A handler is only as honest as the statements it spans. `fork.ts` wrapped a `CREATE TABLE` *and* the twenty-statement `INSERT` loop under it in one catch commented "table may be absent", so a constraint violation on message #400 reported as a missing table and the fork returned success with the owner's whole conversation gone. One catch, one condition
- Prefer asking over catching. `tableExists(sql, name)` and `PRAGMA table_info` turn "absent" into a value; a `catch` cannot tell a missing table from a locked one. DDL by swallowed exception is prohibited — `reconcileColumns` for a column, `initWorkspaceSchema` for a table
- A production `catch` may never accommodate a test-only condition. If a table would be missing in tests, the harness builds the production schema (`createTestWorkspace`), it does not earn a swallow in shipped code
- Where an absence is genuinely expected, name it: `tolerate(op, 'enoent')` / `classify({ cause })` from `@kinu.run/core/obs`. Anything the matcher does not recognise rethrows
- Never log a secret, and never log an object you have not looked inside: no `apiKey`, `authorization`, `body`, `content`, `credential`, `header(s)`, `password`, `prompt`, `secret`, `soul`, `systemPrompt`, `token`. `ReservedLogField` in `@kinu.run/core/obs` makes that a type: a log call carrying one fails to COMPILE, through a variable, an interface, a spread or an index signature alike. A cast still defeats it, and `require-safety-comment-for-type-assertion` makes the cast a written admission
- Every log carries a stable dotted event name (`capability.read_failed`) — that is what makes a failure greppable across Workers Logs and the CLI journal
- Enforced mechanically by the `no-empty-catch`, `no-sentinel-catch`, `require-cause-on-rethrow` and `no-ddl-in-catch` anti-slop rules. Never add an `oxlint-disable` to pass one
- A refusal carries its classification, reason FIRST — `{ reason: ErrorCode, error }` via `refusalOf` — because every seam that shows a result to a human or hashes it for steering bounds it to a head slice, and the prose is the long part. Precedents, cited by name because these lines rot: `failure()` in `tools/file-tool.ts`, the `createTool` catch in `execution/inline.ts`, `unsupported()` in `strategy/swarm-run.ts`, and the refusal helper in `strategy/merge-back.ts`
- `classifyErrorCode` answers `null` when nothing pinned recognises a failure, and `toKinuError` therefore REQUIRES an `otherwise` from its caller. An unknowable cause is a value, never a guessed code: `Worker exceeded resource limits` is what the client sees for BOTH an isolate memory kill and a CPU-time kill, so it is not in the OOM matcher
- The `Observability`/`Tracer` seam is WIRED at **six** production boundaries, measured 2026-08-24 by grepping `this.tracing.invocation`: `orchestrator.ts` `_kinuTimerTick` (`alarm`/`tick`), `recordHeadStep` (`rpc`/`head.record_step`), `actor-agent.ts` `nodeArbitrate` (`rpc`/`swarm.arbitrate`), `exploration.ts` `explore` (`rpc`/`mcts.branch`), `runAsHead` (`rpc`/`head.run`), `runAsNode` (`rpc`/`swarm.node`) — cited by name because the line numbers rotted twice in one week. Two of the four `InvocationKind` values are in use — `alarm` and `rpc` — while `fetch` and `websocket` are declared and unused. This bullet has now been wrong in BOTH directions within one day: it first claimed a test fixture was the only caller, then claimed exactly one production call site, and the second was stale the moment five more landed. Re-grep rather than trusting the sentence. The handle comes from the `tracing` getter on `ActorAgent`, which builds `createAgentTracing({tracer: createWorkersTracer(), isolateGen, selfPath})` once per construction; `createWorkersTracer` (`obs/cf-tracer.ts`) goes through `cloudflare:workers`' `tracing.enterSpan`, the only entry point available at our pin. `selfPath` rather than `ctx.id` because two facets with distinct ids both reported under the ROOT's `durableObjectId` on the deployed runtime, so an id-keyed trace collapses every head and node into one orchestrator. Spans are always scoped, and trace context does not survive a hibernation wake or a cold start. Across `alarm()` it is not merely absent but ENFORCED absent: `tracing.invocation` revokes the handle when the method's promise settles, so a span opened from anything that escaped the tick throws
- The full contract, its status table and the unconverted boundary: [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)

## CF Backend Specifics

- OrchestratorAgent extends `ActorAgent`, which extends `Think<Env>` from `@cloudflare/think`
- Think extends the SDK's `Agent` directly and adds the agentic loop, the turn
  lifecycle hooks, sessions and fibers. Kinu overrides the loop's inputs
  (`getModel` / `getSystemPrompt` / `getTools` / `beforeTurn`) and leaves Think's
  own workspace, skills, actions, channels and scheduled tasks unused
- `getModel()` uses the active resolved profile. The profile catalog maps its tier to a concrete provider model.
- `getTools()` builds the 8-builtin ToolSet (`BUILTIN_TOOLS` in `core/src/tools/registry.ts`): `execute_tools`, `run`, `file`, `agents`, `memory`, `tasks`, `web`, `report`; results are cached per CraftStore version
- **How the model reaches a capability is DECLARED, not derived**: `TOOL_REACH` in `core/src/tools/registry.ts` gives each capability `{ native, codemode }`, where `codemode` is the sandbox NAMESPACE (not a boolean — `run` and `file` reach the sandbox through the shared `workspace` primitives, so they own no namespace). `BuiltinToolName` is derived from it, every `*-codemode.ts` factory takes its provider `name` from it, `explainNativeToolReferenceError` reads it to tell the model where a capability actually is, and `getToolDescriptions` reports it instead of guessing from ToolSet keys. Reach is not permission: what an actor gets is reach ∩ its wired deps, and `getToolDescriptions` reports those two facts separately (`exposure` + `wired`). Adding a native row grows the 8-tool surface, which `core/tests/unit-tool-reach.test.ts` pins by both name set and count
- `agents`, `web`, and `report` are dependency-gated native builtins. `report` appears only on a subordinate's assigned turn, while the `agents` action schema is derived from the actor's wired fork/team/peer capabilities. Release is codemode-only and mechanically omitted in Plan mode. See [docs/TOOLS.md](docs/TOOLS.md)
- `execute_tools`' docstring is composed ONCE, in `registry.renderExecuteToolsDescription(typeBlock)`, and both backends use it: CF passes `@cloudflare/codemode`'s `{{types}}` placeholder and lets `createCodeTool` substitute; the CLI joins its providers' declared `types`. Do not let either backend describe this tool on its own — CF used to ship the vendor's generic `DEFAULT_DESCRIPTION` (none of the registry spec reached the model, and its worked example named a `codemode.<name>` call the dispatcher throws on) while the CLI shipped the spec and discarded every namespace declaration
- `agents` is the ONE delegation surface (`swarm | hire | ask | send | reply | list | dismiss`), and it is projected into the codemode sandbox as the `agents.*` namespace over the same dispatch — so a script can delegate with ordinary control flow. Do not reintroduce `think` / `team` / `peers` as separate tools
- `swarm` is the measured rung. `AgentsForkDeps` supplies the model resolver and workspace used for measurement. `preset` fixes the search tuple ([docs/EXPLORATION.md](docs/EXPLORATION.md)); `objective` defines what counts. The caller's verifier scores candidates unless `score:'judge'` selects the marginalised ensemble. `verify` uses the closed registry in `strategy/verifier-registry.ts`; an unknown kind fails as `bad_input`. `swarmValidity` checks the resolved tuple before anything spends.
- **Every field of `agents` belongs to an ACTION, and an unrecognised one is an ERROR that names the field meant** (`unknown field "budgetUsd" — did you mean "budget_usd"?`). The input schemas are `v.strictObject` over one shared entry set, `parseAgentsToolInput` runs on BOTH surfaces (the tool's own `execute` and every `agents.*` codemode member), and `AGENTS_ACTION_FIELDS` declares what each action's handler reads. It was a flat `v.object`, which EXCLUDES an unknown entry rather than rejecting it: measured 2026-08-18, `{action:'fork', task:'x', budgetUsd:5, wallClockMs:1000}` parsed to `{action:'fork', task:'x'}` — two spend caps asked for and neither applied, silently. `gate:agents-fields` holds the declaration to the CODE (per action, the `input.<field>` reads its `case` arm performs, followed through every whole-input hand-off) so an action cannot join the picklist while its fields join nothing. The resume filter deliberately DROPS instead of refusing — a durable job row is history, not a prompt — and logs `agents.resume.fields_dropped`. See [docs/TOOLS.md](docs/TOOLS.md)
- `memory` is the one durable-state surface: `save | search | conversations` for prose and transcript recall, plus FactsStore-gated `remember | recall | forget` keyed facts. `web` is the one live-web surface: `search | fetch`. Do not reintroduce `fact`, `web_search`, or `web_fetch`.
- `file` is the ONE file plane (`read | edit | write`) over the same workspace filesystem `run` and `execute_tools` address — do not split it into separate `read`/`write`/`edit` tools, and do not add a second filesystem path for it. Its load-bearing property is that an `edit` whose `old_text` is absent or repeated FAILS naming the problem, and that `edit`/overwriting `write` require the file to have been read first. Both are locked by the `file-plane` layergate layer; losing either is what the `file-plane/edits-land-blind` fault models
- Delegation uses one ladder: direct work, `ask` with a `role` for ONE temporary full agent per question (`context_ref` names workspace paths it reads itself; it is a `lifetime:'task'` row in the one `workspace_subordinates` roster, correlated by `task_event_id`, archived when it answers), `swarm` for measured ephemeral nodes, and `hire` for persistent additional agents. `ask` takes `agent` XOR `role`; there is no standalone `rlm`/`llm` codemode namespace. A swarm's context axis is `fork | fresh`; it is not another rung. There is no model-facing `fork` action or settlement field. Tree search at every depth is `action:'swarm'`. `score:'judge'` reaches `evaluateWithMultiModelJudging` and requires at least `JUDGE_MARGINALISATION_MIN` samples on tree advance. The `strategy/mcts.ts` adapter remains available to programmatic and evaluation callers; production lifetime evolution calls `runMCTS` directly. Subordinate trees recurse to `DELEGATION_MAX_DEPTH = 4`, with depth stored in immutable identity. `DELEGATION_FRAME`, `DELEGATION_INHERITANCE`, and `DELEGATION_RUNGS` are the single source for tool doctrine. The prompt carries only the separate operational index.
- `getSystemPrompt()` reads `SOUL.md` from VFS
- `onChatResponse()` fires evolution async (never blocks TurnQueue)
- `beforeTurn()` resets per-turn state counters
- `configureSession()` adds memory context + cached prompt
- `@callable()` methods for RPC from React UI via `agent.call()`
- ExplorationAgent uses `@callable()` for MCTS branch and head operations; MCTS rollouts are toolless, while heads share the canonical file plane with actor-scoped shell/scaffold state

## Architecture Invariants

- `SOUL.md` in VFS is the canonical workspace identity/purpose file (embodied by its default agent); user-editable via the Settings page (`setSoul` @callable RPC). Written at genesis and may be updated by the agent owner; not modified by the agent itself
- `workspace_identity` holds one stable UUID. The workspace is the ownership root and file plane; each agent in it has one durable conversation (see docs/WORKSPACES.md).
- Scaffold is versioned in VFS (`scaffold/agent.js`) + `scaffold_versions` table
- Memory lives in VFS under `memory/` prefix
- MCTS nodes stored in `search_nodes` table
- Crafted tools stored in `crafted_tools` table with EMA scoring
- Tool cache invalidated only when CraftStore version changes (write count)
- Evolution hooks run in background — never block the TurnQueue
- Container executor delegates to ctx.container.getTcpPort().fetch() HTTP API
- SSH executor delegates commands over WebSocket to user's machine

## Network & Port Rules

- Port 3000 is reserved (platform relay) — never bind to it
- Dev servers must bind to `0.0.0.0` (not localhost)
- Wrangler: use `--ip 0.0.0.0` (not --host)

## Common Patterns

```typescript
// Executor tool pattern — positional args, string returns, no throws.
// The string is the CURRENT convention and a known defect (Code Style, above):
// it carries no classification. Until the replacement lands, at least keep the
// cause chain intact on anything that propagates rather than returning.
tools.exec = {
  description: 'Run a command in the environment.',
  execute: async (...args: unknown[]): Promise<string> => {
    const command = parseInput(StringSchema, { value: args[0] });
    if (command === undefined) return 'exec error: command must be a string';
    if (!connected) return NOT_CONNECTED_MSG;
    try {
      const result = await doExec(command);
      return result.stdout || '(no output)';
    } catch (caught) {
      return `exec error: ${errorMessage({ error: caught })}`;
    }
  },
};

// RPC method pattern — @callable() + async
@callable() async getStatus() {
  return this.sql<{ count: number }>`SELECT COUNT(*) as count FROM ...`;
}

// SQL pattern — tagged template for queries, RawSqlExec for DDL, ask don't catch
const rows = this.sql<{ name: string }>`SELECT name FROM tools WHERE active = 1`;
execRaw("CREATE TABLE IF NOT EXISTS my_table (id TEXT PRIMARY KEY)");
if (tableExists(this.sql, 'assistant_messages')) { /* … */ }
```
