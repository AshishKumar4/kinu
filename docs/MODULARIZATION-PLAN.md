# Modularization plan

This document answers three questions about the `packages/*` workspace: what
the package graph is, which seams earn a package of their own, and how to get
there in stages that merge on their own. Every number here was measured on
2026-09-03 at commit `ed67d0126` in `/home/mrwhite0racle/Kinu-wt-modularization`,
a worktree whose `@kinu.run/*` scope resolves inside itself
(`bun test packages/*/tests/workspace-resolution.test.ts`: 7 pass, 7 files).

The vocabulary is the one `codebase-design` uses. A **seam** is where a
module's interface lives. A module is **deep** when a caller gets a lot of
behaviour for a small interface. The **deletion test** asks: delete the seam,
and does the complexity vanish (a pass-through) or reappear across N callers?
AGENTS.md at `ed67d0126` names neither test (`grep -n "deep module\|layering\|worker
internals" AGENTS.md docs/ARCHITECTURE.md docs/EXTENSIBILITY.md` finds nothing).
The written rules this plan applies instead: "Shared core with abstract
interfaces" (AGENTS.md:7), "Platform-neutral policy lives in `packages/core`"
(docs/ARCHITECTURE.md:6), "`AgentRuntime` and `BackendHost` … are the whole
contract" (docs/ARCHITECTURE.md:485-486), "STATE THE REASON OR SHARE THE
CONSTANT" (scripts/policy-drift.ts:59), and "share it, or say where it says
why not" (scripts/capability-parity.ts:18).

## 0. How the numbers were made

| Instrument | Command | Result |
|---|---|---|
| Declared graph | `jq .dependencies packages/*/package.json` | §1.1 |
| Import surface | `grep -rn "from '@kinu.run/" packages/*/src \| cut -d: -f1 \| sort -u \| wc -l`, per package; and `grep -rnE "['\"]@kinu\.run/" packages/*/src` for both quote styles | §1.1; the brief's command misses 60 `cf-backend` files that import with double quotes only (`src/actor-agent.ts` is one) |
| Parity | `bun scripts/capability-parity.ts` | 127 core contracts with optional members, 45 built by both closures, 379 cf construction sites, 321 cli construction sites, 350 adapter source files, 3,989 resolved local imports, 30 specifiers a shared package already imports, 9 contracts skipped as spread |
| Reach | `bun scripts/wired.ts` | 1,055 files that can reach, 849 governed, 5,914 exported declarations, 379 entrypoints, 999 live files, 4,517 symbols reached, 739 locked findings |
| Dead code | `bun scripts/dead-code.ts` | 54 knip candidates, 350 exported declarations, 11 manifests, 107 package declarations, 27 locked findings |
| Client build | `bunx vite build` in `packages/cf-backend` | 2.22 s; then `grep -c` over the client chunks |

`scripts/wired.ts` prints only unwired symbols. The per-seam symbol counts
below come from its exported graph (`buildGraph`, `findEntrypoints`,
`measureReach` over `readMatching(isReacher)`): each import a module
references, resolved to its declaring file through re-exports the way
`declarationSite` does, counted when that file sits in another package. That
is a one-off script; the recipe above is the reproduction.

## 1. Map

### 1.1 Packages: declared against measured

| Package | Declares (`@kinu.run/*`) | Imports in `src` (files, both quote styles) | Brief's command |
|---|---|---|---|
| `agent-utils` | none | none | 0 |
| `core` | `agent-utils`; dev: `test-utils` | `agent-utils` 11 | 11 |
| `compaction` | `core` | `core` 6 | 6 |
| `test-utils` | `core` | `core` 20 | 20 |
| `devbox` | none | none; `bench/measure-first/probe.ts:44` imports `scripts/fixtures/r2-bench/deploy-substrate.ts` by relative path | 0 |
| `pc-agent` | none | none; plain JS, `src/index.js:30` says it "cannot import the constant" | 0 |
| `cli-backend` | `agent-utils`, `compaction`, `core` | `core` 25, `compaction` 1, `agent-utils` 1 | 25 |
| `cli` | `cli-backend`, `core` | `core` 53, `cli-backend` 13; `pc-agent` by relative text import, undeclared (`src/device-connect.ts:26-27`) | 53 |
| `cf-backend` | `agent-utils`, `compaction`, `core`, `devbox` | `core` 163, `devbox` 2, `agent-utils` 2, `compaction` 1 | 103 |

`core` matches 13 files; two are comments naming another package
(`layergate/layers.ts:1532`, `tools/builtins.ts:445`). Third-party imports are
under-declared everywhere: `core/src` imports `ai` in 76 files and `valibot` in
154 and declares neither (`packages/core/package.json:13-18`; the root
`package.json:127,130` carries both; `bunfig.toml` links hoisted). A manifest
here describes little; the gates in §1.5 prove a seam.

### 1.2 What crosses each seam

Production files only; a symbol counts when the importer references it.

| Importer → declaring package | Files | Symbols | Declaring files |
|---|---|---|---|
| `cf-backend` → `core` | 166 | 953 | 256 |
| `cli-backend` → `core` | 25 | 523 | 175 |
| `cli` → `core` | 53 | 253 | 95 |
| `cli` → `cli-backend` | 13 | 36 | 16; two of the 36 are core symbols forwarded by `cli-backend/src/model-resolver.ts:104-106` |
| `compaction` → `core` | 6 | 17 | 12 |
| `core` → `agent-utils` | 11 | 11 | 5 |
| `cf-backend` → `compaction` | 1 | 6 | 3 |
| `cli-backend` → `compaction` | 1 | 5 | 3, the same five |
| `cf-backend` → `devbox` | 2 | 8 | 4 |
| `cf-backend` → `agent-utils` | 2 | 3 | 2 |
| `cli-backend` → `agent-utils` | 1 | 2 | 2 |

Most imported on the `cf-backend` → `core` seam: `obs/error.ts` (8 symbols, 89
importers), `obs/log.ts` (9, 64), `utils/json.ts` (8, 37); widest:
`execution/device-tunnel.ts` (22 symbols, 7 importers). The whole
`core` → `agent-utils` seam is eleven names: four abort and path helpers,
three FTS query helpers, `chunkMarkdown`, `initMemoryChunkTables`, and the
types `SqlExecutor`, `SqlValue`. Inside `core/src`, `obs/` (6 files, 1,353
lines) imports no other core directory and 32 directories import it;
`providers/` (23 files, 3,607 lines) imports only `obs`, `utils`,
`credentials`, `prompts` and the root; `checkpoints/` (318 lines) imports none.

### 1.3 Cycles

One, declared and dev-only: `core` lists `@kinu.run/test-utils` under
`devDependencies` (`packages/core/package.json:20`) and `test-utils` lists
`@kinu.run/core` under `dependencies`. No `core/src` file imports `test-utils`
(0 files by both grep commands); 83 files under `core/tests` do.

### 1.4 Layering facts

1. **The web client's value closure is all of core.** From the three browser
   mounts (`cf-backend/src/index.tsx`, `landing.tsx`, `gallery.tsx`), following
   only value imports (Vite erases `import type`), the closure holds 128 of 250
   `cf-backend/src` files, 415 of 430 `core/src` files and 11 `agent-utils`
   files. 32 client files import the `@kinu.run/core` barrel by value and 39
   import `@kinu.run/core/obs`, the only first hops into core (§2.3 has the use).
2. **Production sheds it; dev does not; nothing gates either.** The client
   chunks (`app-*.js` 1,154.18 kB, gzip 312.67 kB; `use-copy-*.js`
   1,029.87 kB, gzip 320.91 kB) contain 0 hits for ten server-side markers
   (`CREATE TABLE IF NOT EXISTS`, `search_nodes`, `@nimbus-sh`,
   `AsyncLocalStorage`, `execCancel`, `ptyOpen`, `models.dev/api.json`,
   `Retry-After`, the two stub throw strings). In dev "every module it
   re-exports loads in the browser" (`cf-backend/vite.config.ts:33-38`), so
   `client-node-stubs.ts` (36 lines) stubs five `node:crypto` and
   `node:async_hooks` names, aliased at `vite.config.ts:40-52` and
   `gallery.vite.config.ts:27-28`; the recorded failure is the app "blanking …
   before React mounts" (`:35-36`). Core declares no `sideEffects`.
3. **The UI mirrors backend vocabulary by hand.** `cf-backend/src/lib/protocol.ts:171-256`
   redeclares `BackgroundJob` ("Mirrors core BackgroundJob"), `ReleaseStatus`
   (11 members), `ReleaseSource`, `ReleaseChange`, `ReleaseCheck`,
   `ReleaseApproval`, `ReleaseDeployment` and `ReleaseBoard`, which core
   exports from `release/types.ts:1-93` and `jobs/store.ts:24`. Seven client
   files consume the mirror. No gate compares the two: `policy-drift` reads
   numeric constants (`scripts/policy-drift.ts:83`); `duplication` fingerprints
   function bodies.
4. **The CLI frontend reaches past its backend.** `packages/cli/src` imports
   253 core symbols from 95 files, 55 of them from `evolution/`.
   `cli/src/local-inspection.ts` alone imports 25 `evolution` symbols,
   `EventLog`, `RunEventRecorder`, `TriggerRegistry`, `AlarmScheduler`,
   `initEventsHubTables`, `createReleaseStore`, `releaseSqlFromExec` and
   `MctsSearchStore`, and opens the backend's SQLite with them. AGENTS.md:239-240
   names `cli/` the frontend and `cli-backend/` the backend;
   `docs/AGENT-CLIENT-ARCHITECTURE-SPEC.md:221-222` lists that file as a reader.
5. **A re-export crosses a seam.** `cli-backend/src/model-resolver.ts:104-106`
   forwards `CLOUD_PROXY_PROVIDER_IDS` and `cloudProxyBaseURL` from core;
   `cli/src/config.ts:31-32` takes them from `cli-backend`.
6. **The device wire protocol is written twice, and a test reads both.**
   `pc-agent/src/index.js` declares `'ROTATE'`, `'execCancel'`, `'execAck'`,
   `'ptyOpen'` and the five `PTY_*` frames; `core/src/execution/device-tunnel.ts`
   declares the same names. The daemon is "one dependency-free file"
   (`index.js:30`) shipped as text (`cli/src/device-connect.ts:26-27`), so it
   cannot import them. `cf-backend/tests/unit-pc-agent-exec.test.ts` pins the
   cancel, ack and terminal names by value and `unit-device-hub.test.ts` pins
   the rotation pair; a rename on one side goes red there.
7. **Core carries four workarounds for a package that sits above it.**
   `orchestrator/turn-context.ts:110-114` and `orchestrator/turn-lifecycle.ts:372-376`
   declare structural stand-ins for `compaction`'s store; `state/agent-stores.ts:18-20`
   says `createCompactionStateStore` "is deliberately NOT here … Both backends
   keep constructing that one themselves"; `layergate/layers.ts:1531-1534`
   holds a placeholder row that `scripts/layergate.ts:9-17,45-49` fills by
   importing `packages/compaction/src/index`; `identity/workspace-schema.ts:72-76`
   owns compaction's DDL because "that package sits above core". Both backends
   then build the same extension (`cf-backend/src/actor-agent.ts:1495,2475-2490`,
   `cli-backend/src/local-session.ts:883-913`).
8. **A stated consumer does not exist.** `agent-utils/src/vfs/addressing.ts:12-13`
   says `vfsAddressingHint` lives there for "this package's shell emulator".
   Nothing in `agent-utils` calls it; the callers are `core/src/execution/inline.ts:137`
   and `core/src/tools/file-tool.ts:101`, through `core/src/vfs/errno.ts:76`.
   `core/src/types/primitives.ts:17-22` keeps `SqlExecutor` there for the same reason.

### 1.5 What the gates prove today

| Gate | Tier | Proves | Lock |
|---|---|---|---|
| `bun run gate:capability-parity` | commit | an optional core contract member supplied in one adapter closure and not the other; closures `cf: cf-backend/src`, `cli: cli-backend/src + cli/src`, shared `core`, `agent-utils`, `compaction` (`scripts/capability-parity.ts:82-86`) | 130 keys: 100 `movable`, 30 `asymmetry` |
| `bun run gate:wired` | push | every production export is reached from an entrypoint | 739 keys; 438 in core, 7 in agent-utils, 1 in compaction |
| `bun run gate:dead-code` | push | knip's three classes plus a manifest declaration no served file imports | 27 keys, 2 `unused-dependency` |
| `bun test packages/*/tests/workspace-resolution.test.ts` | setup | `@kinu.run/*` resolves inside the running tree | none |
| `bun run gate:policy-drift` | commit | a numeric constant written twice | numeric only |

The lock is a ledger: a new key fails, and a key that no longer reproduces
also fails until `--lock` records the cleanup
(`scripts/gate-ratchet.ts:12-17,98-113`). A moved file changes its keys.

## 2. Design

### 2.1 Verdicts

| Candidate | Verdict | Deep-module answer | Deletion-test answer |
|---|---|---|---|
| `@kinu.run/core/wire` subpath | add (§2.3) | hides which core modules a browser may load | delete it and the stubs, both alias blocks and the blank-app failure of fact 2 return |
| `agent-utils` | fold into core (§2.4) | hides nothing a caller can use without core; all three consumers depend on core | delete it and eleven imports go relative; the two stale reasons of fact 8 vanish |
| `compaction` | fold into core (§2.4) | ladder plus codec is one deep module already (`compaction/src/index.ts:4-7`); the package edge costs the four workarounds of fact 7 | delete it and the workarounds and both twin construction sites go |
| `devbox` | keep | a container "presented as a machine that stays" (docs/ARCHITECTURE.md:47-51) behind `Devbox`, `DevboxStore`, `DevboxPolicy`; it imports nothing of Kinu; two adapters: `KinuSandbox` (`cf-backend/src/kinu-sandbox.ts:28-30`) and `BenchBox` (`devbox/bench/worker.ts:389`) | inline it into `cf-backend` and Kinu policy mixes with container durability, which `kinu-sandbox.ts:5-11` moved out whole |
| `test-utils` | keep | test scaffolding; carries the workspace-resolution invariant | dev-only; its cycle is declared only (§1.3) |
| `pc-agent` | keep | a dependency-free daemon shipped as one file | it cannot import, so no package unifies its constants; a test does |
| `cf-backend`, `cli-backend`, `cli` | keep as the adapters | the parity closures (`capability-parity.ts:82-86`) | none proposed |
| `@kinu.run/obs` package | reject | `obs/` is a leaf used by 32 directories; `@kinu.run/core/obs` is already its seam | no consumer needs it without core; `devbox` keeps its own renderer (`lifecycle.ts:872`) by design |
| `@kinu.run/providers` package | reject | 8 core directories import it; every outside consumer depends on core | a manifest more, no caller changed |
| a device-protocol package | reject | the second adapter is `pc-agent`, which cannot import | fact 6 needs a test |
| a web package split of `cf-backend` | reject | the client's seam is with core's barrel (fact 1); one manifest and one deploy serve both halves | a package cannot express a seam inside one manifest |
| `checkpoints` package | reject | 318 lines, three consumers, all on core | pass-through |

### 2.2 What stays in core

Everything the adapters share: the turn pipeline and `ExtensionHost`, tools,
prompting, orchestrator, evolution, MCTS, scaffold, craft, strategy, heads,
subordinates, events, execution, vfs, identity, read-models, providers,
profiles, obs, safety, memory, jobs, release, checkpoints; after the stages,
also the memory and craft stores, the abort and path helpers, the compaction
ladder and codec. The parity lock names 100 adapter modules that "would
compile in a shared package" (`capability-parity.ts:13-15`); that queue runs
the same way, into core, and this plan does not schedule it.

### 2.3 The seam to add: `@kinu.run/core/wire`

A subpath export beside `./obs` and `./workspace`
(`packages/core/package.json:7-12`). A package would add a manifest and no
guarantee: the client and the worker share `cf-backend/package.json`, so no
manifest can say "the client depends only on wire". A gate over the subpath's
closure can.

- **Owns:** the vocabulary a client renders: constants, valibot schemas, pure
  functions over plain data. Measured, the client takes 103 values from 43
  files: `read-models` 14, root 14, `utils` 10, `obs` 8, `profiles` 8, `tools`
  8, `execution` 7, `advisor` 6, `events` 4, and fourteen directories with 1-3.
- **Hides:** which core modules reach `node:`, `@nimbus-sh/*`, `ai`,
  `@ai-sdk/*`, `acorn`, `cloudflare:`. Today a comment and five stubs hold that
  policy (fact 2).
- **Callers no longer know:** whether a symbol's declaring module is safe to
  load. They import `@kinu.run/core/wire` and `@kinu.run/core/obs`, never the
  barrel.
- **Smallest honest API:** the 103 values plus the types the client imports,
  re-exported by name from their declaring files; types cost nothing at
  runtime. 34 of the 43 declaring files already have a browser-safe value
  closure. Nine do not: `profiles/catalog.ts`, `advisor/review.ts`,
  `strategy/swarm.ts`, `release/approval-digest.ts` and `chat.ts` reach
  `node:crypto` through `safety/argument-digest.ts:15`;
  `events/hub/visibility.ts:24` imports it itself; `advisor/review.ts`,
  `steer-branch.ts` and `mcts/takes.ts` reach `ai` through
  `prompts/structured.ts`; `chat.ts` and `llm.ts` import `ai` and `@ai-sdk/*`
  themselves. Stage 3 moves the vocabulary out of those nine files.
- **Gate:** `gate:wire-closure`, a push-tier script over `scripts/sources.ts`
  and the resolver in `scripts/wired.ts`. It fails naming the first module in
  `core/src/wire.ts`'s value closure whose specifier starts with one of the six
  prefixes above, fails when the three browser mounts' value closure contains
  `core/src/index.ts`, prints both closure sizes on its green path, and is
  proved red once by pointing it at the barrel.

The production bundle gains nothing measurable (fact 2); what the stage buys
is the gate.

### 2.4 Two packages to fold into core

**`agent-utils`.** 15 files, 1,013 lines. Its consumers are `core` (11
files), `cf-backend` (2), `cli-backend` (1), and each depends on core. Its
two written reasons for existing name a consumer that does not exist (fact 8).
`wired` lists seven of its exports as unreached. The memory subsystem is
split across two packages: the FTS5 store and chunker below, `FactsStore`,
`VectorStore` and `hybridSearch` above (`core/src/memory/`).

**`compaction`.** 8 files, 1,795 lines, all Kinu policy: the codec, the
extension factory, the stores, the summarizer, the manifest and a layergate
slice. The ladder is the dependency `@better-compact/core`
(`compaction/package.json:11`, `src/index.ts:14`; `docs/ARCHITECTURE.md:230-231`
still names a `compaction/src/engine/` that is not there). The package edge
costs core four workarounds and each backend a twin construction site (fact
7). After the fold, `createAgentStores` builds the compaction state store and
one core factory builds the extension; the backends stop assembling five
symbols each.

## 3. Plan

Rules every stage follows:

- A stage merges alone, in any order. No stage leaves a shim, an alias or a
  re-export; a moved symbol is imported from its new home at every call site.
- Re-lock rule for `wired`, `dead-code` and `capability-parity`: a stage may
  run `--lock` only when every `added` key is a `stale` key under the path
  rename; a `stale` key with no counterpart is resolved debt and is recorded;
  the key count never grows. Any other `added` key blocks the stage.
- Compatibility, both backends, by command: `bun run check`; `bun run test`;
  `bun test --parallel=4 packages/cf-backend/`; `bun run test:workerd`;
  `bun test --parallel=4 packages/cli-backend/`; `bun run test:cli`;
  `bun test packages/devbox/`; `bun test packages/test-utils/`;
  `bun test packages/pc-agent/`. Run in the stage's own worktree, after
  `bash scripts/setup-worktree.sh`, or `bun install` when `bun.lock` changed.
- The workspace-resolution invariant runs last, one file per remaining
  package: `bun test packages/*/tests/workspace-resolution.test.ts`.

### Stage 1: `agent-utils` into `core`

Files that move (15 under `packages/agent-utils/src`): `core/utils.ts` (the
abort helpers and `normalizePath`) → `core/src/utils/`; `types.ts` →
`core/src/types/primitives.ts`, which already forwards `SqlExecutor` and
`SqlValue` (`primitives.ts:22`); `memory/{chunker,query,store}.ts` →
`core/src/memory/`; `stores/craft.ts` and `codemode/builder.ts` →
`core/src/craft/`; `vfs/addressing.ts` → into `core/src/vfs/errno.ts`, its
only importer; `vfs/types.ts` → `core/src/vfs/`. `vfs/encoding.ts`,
`vfs/walk.ts` and the three barrels are decided by reach: `wired` names four
of their exports unreached, and what nothing reaches is deleted with its
tests. The five memory suites and `helpers.ts` move to `packages/core/tests`.

Imports that change: 11 core files (`execution/{device-tunnel-executor,nimbus,parent,sandbox}.ts`,
`memory/conversation-search.ts`, `jobs/background-wrap.ts`,
`identity/{inline-primitives,workspace-schema}.ts`, `read-models/files.ts`,
`types/primitives.ts`, `vfs/errno.ts`) go relative;
`cf-backend/src/memory-sync.ts:15`, `cf-backend/src/runtime.ts:62-63` and
`cli-backend/src/runtime.ts:52-53` import from `@kinu.run/core`; six tests
(`cf-backend` 2, `cli-backend` 1, `core` 3) follow. Seven core comments that
explain the old placement (`errno.ts:73-76`, `primitives.ts:17-22`,
`identity/fork.ts:236`, `identity/schema.ts:72`, `workspace-schema.ts:286`,
`inline-primitives.ts:80`, `types/agent-runtime.ts:31`) are rewritten.

Configuration that changes: the package's `package.json` and `tsconfig.json`
go; the dependency leaves the `core`, `cf-backend` and `cli-backend`
manifests; root `package.json` `test` (line 19), `check` (line 24) and `knip`
workspaces; `scripts/capability-parity.ts:86`; the `bun run test` row in
`scripts/ladder.ts`; `tools/oxlint/anti-slop/rules/no-untyped-console.ts:59`;
AGENTS.md:239 and `docs/ARCHITECTURE.md:448,459-466`. 51 files outside the
package name it (`grep -rl agent-utils . --include='*.ts' --include='*.json'
--include='*.md' --include='*.yml'`, less `node_modules` and the package);
the stage walks that list.

Gate: `bun run gate:dead-code` reads one manifest fewer and reports no new
`unused-dependency`; `bun run gate:wired` re-locked under the rule (739 keys
or fewer; the 7 agent-utils keys reappear under core paths or leave with their
symbols); `bun run gate:capability-parity` with `agent-utils` out of the
shared list and "specifiers a shared package already imports" at 30 or more;
`bun run gate:duplication` unchanged; the workspace-resolution invariant.

Compatibility: the nine commands. `bun run test` drops `packages/agent-utils/`.

### Stage 2: `compaction` into `core/src/compaction/`

Files that move (8 under `packages/compaction/src`): `codec.ts`,
`extension.ts`, `stores.ts`, `summarizer.ts`, `manifest.ts`, `layergate.ts`,
`layergate-baseline.ts`, `index.ts` → `core/src/compaction/`. The existing
`core/src/compaction.ts` (the summary prompt) becomes `compaction/prompt.ts`.
The six `unit-*.test.ts` files and `helpers.ts` move to `packages/core/tests`.

Imports that change: `cf-backend/src/actor-agent.ts:50-54` (6 symbols) and
`cli-backend/src/local-session.ts:23-27` (5) import from `@kinu.run/core`;
`cli-backend/tests/compaction-integration.test.ts` and
`core/tests/unit-agents-swarm-shared-prefix.test.ts` follow. Inside core,
`turn-context.ts:110-114` and `turn-lifecycle.ts:372-376` take the concrete
`CompactionStateStore` type; `state/agent-stores.ts` builds `compactionState`;
`layergate/layers.ts:1531-1534` holds the real slice;
`scripts/layergate.ts:9-17,27-32,45-49` loses its merge step and imports one
`LAYERS`.

Configuration that changes: the package's `package.json` and `tsconfig.json`
go; `@better-compact/core` joins `core/package.json`; `cf-backend` and
`cli-backend` drop the dependency; root `test`, `check`, `knip`;
`scripts/capability-parity.ts:86` loses `compaction`; `scripts/ladder.ts`;
`no-untyped-console.ts:60`; `no-elapsed-work-deadline.ts:99-102`;
`docs/ARCHITECTURE.md:229-244`. 32 files outside the package name it (the
same grep with `kinu.run/compaction\|packages/compaction`).

Gate: `bun run gate:dead-code` with `@better-compact/core` declared once and
used; `bun run gate:wired` re-locked under the rule (the one compaction key,
`codec.ts#kinuConventions`, reappears under core or leaves);
`bun run gate:capability-parity` re-locked: the cf and cli construction-site
counts fall as the twin sites collapse into core, and `assertMeasured` still
sees every count above zero; `bun run layergate` reports the 18 measured
layers `scripts/ladder.ts:1189` records, and `--matrix` localises the ladder
faults as before; the workspace-resolution invariant.

Compatibility: the nine commands, plus
`bun test packages/cli-backend/tests/compaction-integration.test.ts` and
`bun test packages/core/tests/unit-layergate.test.ts`, each pinning the ladder.

### Stage 3: `@kinu.run/core/wire` and the client cutover

Files that change: new `core/src/wire.ts` exporting the 103 values and the
client's types by name; `packages/core/package.json` `exports` gains
`./wire`. The nine declaring files of §2.3 split: each keeps its digest or
model code and moves its constants, schemas and pure functions to a sibling
module the wire index names, and imports them relatively, so no caller of the
original changes.

Imports that change: the 32 client files that import the barrel by value and
the 39 that import `core/obs` import `@kinu.run/core/wire` and
`@kinu.run/core/obs` only. Lines 171-256 of `cf-backend/src/lib/protocol.ts`
are deleted and their seven consumers (`ReleasesSurface.tsx`,
`WorkSurface.tsx`, `WorkTab.tsx`, `ExplorationSurface.tsx`, `fork-runs.ts`,
`work-jobs.tsx`, `hooks/use-kinu.ts`) take `BackgroundJob` and the `Release*`
types from `wire`. `cf-backend/client-node-stubs.ts` goes with the alias at
`vite.config.ts:40-52` and `gallery.vite.config.ts:27-28`. The worker keeps
the barrel.

Gate: `gate:wire-closure` (§2.3), added in this stage at the push tier with a
`scripts/wire-closure.test.ts` that proves both red directions;
`bun run gate:wired` re-locked under the rule (the split files change keys);
`bun run gate:dead-code`; `bun run gate:capability-parity` unchanged, since
the split touches core only; the workspace-resolution invariant.

Compatibility: the nine commands, plus the surfaces the stubs protected:
`bunx vite build` in `packages/cf-backend` with the ten-marker grep of fact 2
at 0; `bun test scripts/react-runtime-identity.test.ts` (the real client
build twice, three routes in Chromium); `bun test scripts/public-pages.test.ts`;
and one dev-mode smoke: `bun run dev`, then `/` renders the signed-out page.

### Outside the stages

Three facts above call for a gate or a layering repair, and no stage claims
them. Fact 6 needs one test that reads `pc-agent/src/index.js` and
`core/src/execution/device-tunnel.ts` and holds the four strings equal. Fact 5
needs `cli/src/config.ts:31-32` to import from `@kinu.run/core` and the
forward at `cli-backend/src/model-resolver.ts:104-106` to go. Fact 4 needs
the reads in `cli/src/local-inspection.ts` to live in `cli-backend`; the
proof is `bun run test:cli`.
