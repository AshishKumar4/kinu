# Kinu — Agent Guide

Self-evolving agent framework: MCTS exploration, mutable scaffolding, durable skill evolution. Two backends over one core: Cloudflare Workers (`cf-backend`, Think DOs) and local CLI (`cli-backend`, bun:sqlite). Bun workspaces under `packages/*`.

## Commands
`bun install` · `bun run check` (strict lint + typecheck; all anti-slop rules are errors, warnings fail) · `bun test --cwd packages/core` · `bun run dev` · `bun run layergate` · `bun run deploy` (the only deploy path; never bare `wrangler deploy`) · `bash scripts/setup-worktree.sh` (once per fresh worktree; never symlink the primary's `node_modules`; never `bun install` in a linked worktree, the root `preinstall` refuses).

## Gates
- A gate governs exactly the set it measures; read the corpus through `scripts/sources.ts`, never a hand list. Prove a gate red in every direction it claims before trusting it green; print its blind spots on the green path.
- A red gate is work. Never: `--no-verify`, `oxlint-disable`, an allowlist or ignore entry, a severity downgrade, a narrowed assertion, a skipped or deleted test, a raised timeout, a lock ratchet. Either the code is wrong or the fixture is stale; fix that one. A rule you think is wrong is surfaced with evidence, not bypassed.
- A defect the owner finds by hand gets a `tests/first-run/` row proved red against the deployed build before its fix ships; `gate:first-run` runs on every deploy against the product.
- A fixture that can no longer fail is worse than red; restoring its red direction is part of the same change. Retire a corpus entry only after showing no live code holds its property.
- A verification claim names the tree, the command, and the revision. A subagent's summary is a claim to check.
- Locks keyed by path (`schema-genesis`, `wired`, `complexity`, `pattern-inventory`) are re-keyed on the path half only when a file moves; values stay byte-identical.
- `gate:core-layering`: `packages/core` is platform (`obs utils types identity vfs execution events memory safety slates providers config credentials checkpoints`, plus root files by name), tools (`tools craft web`), harness (everything else). Imports point down or sideways, never up; the lock shrinks only.
- `gate:client-graph`: no path from a client entry reaches `@agent-core/core` or `bun:sqlite`.

## Vendored
- `tools/oxlint/anti-slop`: upstream `dmmulroy/anti-slop` pinned in `upstream.json` with per-file digests; `drift.test.ts` names any divergence. Local strengthenings are declared deltas with a reason. Sync: clone upstream, merge `rules/` and tests, `ANTI_SLOP_UPSTREAM=<clone> node --experimental-strip-types tools/oxlint/anti-slop/drift.test.ts --update`, `bun run test:anti-slop`. A sync is a strict improvement: every fixture rejected before is rejected after; an upstream weakening is declined as a delta.
- `packages/agent-core/dist`: private upstream runtime, digest-pinned by its own `upstream.json` and `drift.test.ts`; never edit its bytes.

## Worktrees
- Agents never edit the primary checkout. Every edit/write path is absolute under your worktree; an edit's section header carries the same absolute path the tag was read from. After the first edit, `git -C <worktree> status` must show it. Resolve the primary by `git worktree list` row one, never a literal path. A stray edit in the primary is reverted path-scoped; never a bare checkout or reset there.
- Parallel writers use isolated worktrees and focused commits; main merges and verifies each.
- `archive/*` tags carry unreachable blobs; read `docs/BRANCH-ARCHIVE.md` before deleting one.

## Cost Never Gates Work
The owner is a Cloudflare employee; Workers, DOs, R2, Containers, Sandboxes, Workers AI and inference are free here. Never defer, cap, or refuse a run, bench, probe, deploy, or measurement on cost, and never call one "paid". Two things stay: the 10 MB gzip bundle cap is a platform limit and is measured (`bunx wrangler deploy --dry-run` after a fresh `bunx vite build`; record the figure with its sha in the deploy record), and the `agents` tool's `budget_usd`/`budget_tokens`/`budget_label` are a product feature. No migrations, cutovers, or compatibility periods: a schema change is a reset deployment, a rename moves every caller in one commit, a deprecated path is deleted.

## Deploy
- One environment: https://kinu.run. No staging, no environment flag in any test or gate. `scripts/deploy.sh`: gates → build → CLI archive → upload → smoke → first-run tier → infra verify. `GET /api/health` reports `{version, sha, builtAt}`; check it after every deploy. Startup limit is 1 s; measure, do not cite.
- The eval identity (`DEV_USER_EMAIL` + `DEV_IDENTITY_SECRET`) lives on the deployment; evals act as `eval-service`, never a person's session, with the eval workspace prefix and teardown.

## Commit Messages
- Subject `type(scope): text` or `type: text`, ≤80 chars; type ∈ `fix feat docs bench test refactor chore cli core mcts cf gate heads eval evolution prompt`. Body ≤4 more lines, usually none. `scripts/commit-hygiene.ts` enforces it and the `commit-msg` hook runs it.
- Never name a subagent, credit the requester, treat a session as a unit of work, or write in first person. The owner as a modelled entity is fine.

## Requests Ledger
`docs/research/REQUESTS-LEDGER.md` (primary checkout only; gitignored) holds every request with its verifying command. A row is DONE only when its command passes; no command means UNVERIFIED and open. Read it before claiming a request closed; add a row when one arrives. Two copies with different contents is a fork; say so.

## Delegation
Default is solo. Delegation must beat the single-agent effort curve (measured: an orchestrator over 25 workers scored 10–12 points below solo at higher cost on dependent work). Do coupled, dependent, or single-context work yourself. Delegate only a whole coherent problem independent of your own work. `scout` for research, `task`/`sonic` for mechanical writes to a fixed spec, `expert` only for load-bearing judgement; at most 2–3 experts at once; never split one dependent chain across lanes. Every lane gets full context, an output contract, its own worktree; its result is a claim to verify.

## Owner Preferences
- Short commit subjects; no comment that restates code or narrates an edit.
- All business logic in core; `cf-backend`, `cli-backend`, `cli` are adapters. When two backends implement one rule differently, the stricter side wins and becomes the shared path, one commit with a pin test.
- Dump suite and large tool output to `/tmp` and read the tail. Conclusion first, plain language, decision-relevant detail only; name contradictions between asks.

## Docs
- `no-ai-slop` standard, ASD-STE100, Zinsser order (simplicity, brevity, clarity, humanity); the reader wins over the letter of STE. Owner's first-person voice for user-facing prose. No AI-edited disclaimer line here (two generators write docs and print none).
- A doc states what was measured with number and date, or says it is unmeasured. One name per referent: a swarm's agent is a swarm node, never a "search node" (`search_nodes` is a table). Verify symbols, paths, and counts against source before a doc lands; no prose-shape or doc-claim gates.
- Code reviews load `thermo-nuclear-code-quality-review`; name it in reviewer briefs.

## Packages
`core` (interfaces, MCTS, evolution, scaffold, craft) · `cf-backend` (Think DOs, React UI, Vite+Wrangler) · `agent-utils` (stores, VFS types) · `cli` · `cli-backend` · `compaction` · `devbox` · `test-utils` · `tests/` (E2E) · `bench/clbench/`.

## Architecture
- One Durable Object per workspace: files, conversation, ledgers, memory index in one SQLite. Every non-root kind (hired subordinate, exploration head, swarm node, branch) is a logical actor of that object, one identity row per actor, hosted through `subordinate-hosting.ts` / `exploration-hosting.ts`; they run `runHeadInference` and record no turn into the evolution window.
- `OrchestratorAgent extends ActorAgent extends Think<Env>`; Kinu overrides `getModel` / `getSystemPrompt` / `getTools` / `beforeTurn`; Think's workspace, skills, actions, channels, scheduled tasks are unused. `@callable()` exposes RPC to the UI; `rpc-surface.ts` seals what a stub-holder can reach.
- `AgentRuntime` bundles six primitives: `VFS Memory Executor LLM Schedule Identity`. `SqlExecutor` is tagged-template SQL; `RawSqlExec` only for `CREATE ... IF NOT EXISTS`; schema init is idempotent, genesis is locked, no column reconcile ever.
- Execution: `workspace` (Nimbus over the DO's SQLite; canonical files, shell, git; hosted `node` refuses runtime compilation), `sandbox` (Linux container), `laptop` (user's machines via tunnel, one grant per workspace+machine, mounted at `/pc` or `/pc/<name>`), `parent` (forks). One file plane; mounts extend the view, never copy it. Capabilities are rendered into the prompt from `TOOL_REACH`; see `docs/EXECUTION-LAYER-SPEC.md`.
- Eight native tools (`BUILTIN_TOOLS`): `execute_tools run file agents memory tasks web report`. Reach is declared in `TOOL_REACH`, not derived. `agents` is the one delegation surface: `swarm | hire | msg | list | dismiss`; every field belongs to an action and an unknown field is refused naming the one meant (`gate:agents-fields`). `file` is `read | edit | write` with edit refusing absent or repeated `old_text` and requiring a prior read. `memory` is `save | search | conversations | remember | recall | forget`; `web` is `search | fetch`. `execute_tools`' description is composed once in `registry.ts`. Never reintroduce removed tools or actions.
- `SOUL.md` in VFS is the workspace identity; scaffold versioned in VFS; MCTS in `search_nodes`; crafted tools in `crafted_tools` (workspace-wide, no `actor_id`) with EMA scores; evolution runs async and never blocks the turn queue.
- The AI SDK (`ai`) is required by Think and is not up for replacement. `@earendil-works/pi-*` is a bench subject only; oh-my-pi (`can1357/oh-my-pi`) is the source for borrowed ideas, cited.
- Port 3000 is reserved; dev servers bind `0.0.0.0`; wrangler uses `--ip 0.0.0.0`.

## Errors and Logs
- No catch discards its error: do not catch; or wrap and rethrow with `cause`; or handle a domain value and say so. One catch spans one condition. Ask (`tableExists`, `PRAGMA`) instead of catching; no DDL in a catch; no production catch for a test-only condition. `tolerate(op, 'enoent')` / `classify({ cause })` from `@kinu.run/core/obs` for expected absences.
- Never log a secret or an object you have not looked inside; `ReservedLogField` makes that a compile error. Every log carries a stable dotted event name. `toKinuError` requires an `otherwise`; unknown causes are values, not guessed codes.
- Executor commands return `CommandResult` (output or a structured refusal via `commandResult`/`refusalOf`); native tool failures use the SDK error channel through `ToolOutcome`. See `docs/OBSERVABILITY.md`.
- No elapsed deadlines on LLM, turn, delegation, swarm, or compaction work; work ends on completion, definitive failure, or cancellation.

## Code Style
- TypeScript strict, ES2022, ESNext modules, bundler resolution, `verbatimModuleSyntax`. Relative imports carry no extension (`tools/oxlint/anti-slop/**` and `scripts/sources.ts` run under raw Node and keep `.ts`; `import-extension.gate.test.ts` pins that closure). Extensions only for real `.json`/`.mjs`/`.cjs`/`.js` files.
- Vercel AI SDK v6 `tool()` + `jsonSchema()`; `ToolSet` from `ai`. Executor tools use positional args.
