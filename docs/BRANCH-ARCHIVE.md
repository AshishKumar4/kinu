# Branch archive: safe branch deletion

`archive/*` tags retain content absent from `main` after a branch is deleted.
Deleting a load-bearing tag destroys it silently: no test fails, no gate fires,
and `git gc` collects the blobs.

## Rule

Never delete a tag under `refs/tags/archive/` until the test reports zero novel
blobs. A nonzero count is the last home. Delete branches. Keep tags.

## Tag inventory

There are 143 lightweight tags under `refs/tags/archive/`. The first forty are
inventoried below: nine predate the 2026-08-21 prune wave, which added thirty-one.
Those measurements use `main` at `29f654bd` and `c143c4b6`, respectively.

Blobs `main` lacks are absent from its history. Sole-copy blobs have no other
ref. Re-measure the sole-copy count after pruning.

| Tag | Commit | Commits | Blobs `main` lacks | Sole copy |
|---|---|---|---|---|
| `archive/agents-sdk` | `00d7d0e9` | 917 | 3006 | 4 |
| `archive/chat-pagination` | `aa8e4d03` | 1714 | 5525 | 0 |
| `archive/do-resilience` | `8468735c` | 1133 | 3537 | 24 |
| `archive/latency-instrumentation` | `21dc6d44` | 43 | 196 | 0 |
| `archive/nimbus-measure` | `dc02ef08` | 917 | 3016 | 14 |
| `archive/one-filesystem-mounts` | `98c4f285` | 1469 | 4955 | 0 |
| `archive/pre-launch-history` | `36025045` | 1149 | 4824 | 307 |
| `archive/pre-reroot` | `8e98574c` | 1529 | 5062 | 0 |
| `archive/stability-audit` | `1a1c9341` | 229 | 843 | 0 |

No tag is safe to delete. Two re-roots (982 commits, then 84, measured
2026-08-21) left `main` without this pre-launch history. `archive/pre-reroot`
retains the graph and authorship `git filter-repo --mailmap` rewrote, including
5,062 blobs. That explains the larger 2026-08-19 readings.

| Tag | Pins the tip of |
|---|---|
| `archive/one-filesystem-mounts` | `feat/one-filesystem` (branch still present) |
| `archive/nimbus-measure` | `spike/nimbus-measure` (branch deleted) |
| `archive/stability-audit` | `feat/agent-view-redesign` (branch deleted) |
| `archive/latency-instrumentation` | `fix/latency-instrumentation` (branch deleted) |

Five tags have no recorded branch name. I rejected `feat/one-filesystem`
(AGENTS.md § Execution Layer; `packages/cli-backend/tests/mount-plane.test.ts`).
Delete its branch. Keep its tag.

`archive/pre-launch-history` reaches 1,149 commits `main` lacks, the
2026-08-19 base `5dbc0f1b`, and (during the 2026-08-20 prune wave) 60+ deleted
branch tips. 307 blobs exist nowhere else.

### The 2026-08-21 prune wave

I created and verified each tag before deleting its branch. Tags omit the type
prefix (`fix/reliability-a1a3` becomes `archive/reliability-a1a3`). Counts use
`main` at `c143c4b6`; sibling refs make sole copy 0.

| Branch (deleted) | Tag | Commit | Commits | Blobs `main` lacks | Sole copy |
|---|---|---|---|---|---|
| `chore/kinu-rename` | `archive/kinu-rename` | `074ad285` | 1049 | 4523 | 0 |
| `proof/fabric-v2-port` | `archive/fabric-v2-port` | `7f47f958` | 1049 | 4411 | 0 |
| `fix/d1-removal-kv-auth` | `archive/d1-removal-kv-auth` | `6863c622` | 1089 | 4439 | 0 |
| `bench/tbench-run-3` | `archive/tbench-run-3` | `ec7baac5` | 1088 | 4409 | 0 |
| `chore/commit-hygiene-gate` | `archive/commit-hygiene-gate` | `ef3e9a70` | 845 | 4198 | 0 |
| `gate/patch-parity` | `archive/patch-parity` | `0b4f1064` | 845 | 4197 | 0 |
| `cutover/settle-mcts` | `archive/settle-mcts` | `096fcc65` | 1871 | 5933 | 0 |
| `feat/agent-nodes` | `archive/agent-nodes` | `7a0598b6` | 846 | 4194 | 0 |
| `feat/agents-swarm` | `archive/agents-swarm` | `8a464199` | 1839 | 5902 | 0 |
| `feat/node-substrate` | `archive/node-substrate` | `7d1cbea9` | 1885 | 5946 | 0 |
| `feat/records-judge` | `archive/records-judge` | `b8fb9f05` | 871 | 4214 | 0 |
| `feat/swarm-depth` | `archive/swarm-depth` | `e703cd98` | 1869 | 5932 | 0 |
| `feat/merge-back-wiring` | `archive/merge-back-wiring` | `fd482aa0` | 863 | 4210 | 0 |
| `feat/infra-provision` | `archive/infra-provision` | `a21becc0` | 1844 | 5906 | 0 |
| `fix/strict-agents-input` | `archive/strict-agents-input` | `88dffa5d` | 1793 | 5827 | 0 |
| `spec/axis-ergonomics` | `archive/axis-ergonomics` | `461fd28c` | 1801 | 5854 | 0 |
| `spec/exploration` | `archive/exploration` | `f2ff9db1` | 1806 | 5829 | 0 |
| `chore/antislop-core` | `archive/antislop-core` | `d4afc4d5` | 1471 | 5027 | 0 |
| `chore/antislop-cf` | `archive/antislop-cf` | `fa7a15fe` | 1474 | 4984 | 0 |
| `chore/antislop-cli` | `archive/antislop-cli` | `e000b3b0` | 1471 | 4925 | 0 |
| `chore/antislop-scripts` | `archive/antislop-scripts` | `dff86db3` | 1472 | 4931 | 0 |
| `feat/delegation-root-cause` | `archive/delegation-root-cause` | `24223bd8` | 1640 | 5367 | 0 |
| `eval/staging-identity` | `archive/staging-identity` | `17cadf03` | 1095 | 4529 | 0 |
| `cutover/strategy-subsystem` | `archive/strategy-subsystem` | `3b7fb04a` | 1034 | 4389 | 0 |
| `fix/bench-patch-anchors` | `archive/bench-patch-anchors` | `49287e4c` | 1773 | 5791 | 0 |
| `feat/delegation-semantics` | `archive/delegation-semantics` | `1fa43819` | 1756 | 5662 | 0 |
| `work/import-cycle-gate` | `archive/import-cycle-gate` | `9777dcd0` | 936 | 4283 | 0 |
| `feat/swarm-tree-ux` | `archive/swarm-tree-ux` | `ad0dc3ea` | 919 | 4288 | 0 |
| `feat/merge-back` | `archive/merge-back` | `d170729e` | 849 | 4200 | 0 |
| `feat/executor-errors` | `archive/executor-errors` | `e2fe40cb` | 1756 | 5638 | 0 |
| `fix/reliability-a1a3` | `archive/reliability-a1a3` | `2b5d8dfe` | 1093 | 3344 | 0 |

I traced successors in `packages/core/src/strategy/`, `tools/oxlint/anti-slop/`,
`packages/cf-backend/src/auth/store.ts`, and `scripts/commit-hygiene.ts`.
Untraced branches wait on an owner ruling.

`archive/reliability-a1a3` records a 2026-08-10 crash: stale `index.lock`, no
index, and 272 of 1,179 files at `df014c73`. Its work had landed:
`packages/cf-backend/src/hooks/use-kinu.ts` cites STABILITY-AUDIT §A1 and §A3.


### The 2026-08-30 credential redaction

A local history scan found two expired access tokens for this deployment in one old
owner-message record. No remote ref reached that blob. Four local refs did: one branch
and three archive tags. An isolated `filter-repo` pass replaced only those two token
strings with a bracketed `REDACTED-*-ACCESS-TOKEN` marker carrying the then-current
product name. Search the rewritten blobs by that prefix, not by the name.

The rewrite produced 1,871 old-to-new commit mappings. Every rewritten commit kept
its parent topology, author, committer, message, and every non-target path. No commit
was pruned. The branch and `archive/isolation-design` tag remain on one shared tip.

| Ref | Old tip | Redacted tip | Commits | Blobs `main` lacks | Sole copy |
|---|---|---|---:|---:|---:|
| `fix/inspect-events-row-shape` | `a3e0752c` | `1a4ca8e8` | 1866 | 5923 | 0 |
| `archive/isolation-design` | `a3e0752c` | `1a4ca8e8` | 1866 | 5923 | 0 |
| `archive/settle-mcts` | `dd81adcb` | `096fcc65` | 1871 | 5933 | 0 |
| `archive/swarm-depth` | `b19c36f5` | `e703cd98` | 1869 | 5932 | 0 |

Measured 2026-08-30, the repository has 143 `archive/*` tags. The three affected
redaction tags still carry nonzero novel blobs and have zero sole-copy blobs
because sibling refs retain the same objects. No tag was deleted.

### The pre-rewrite safety anchor

`save-pre-reword` named one pre-rewrite savepoint branch. Before pruning that
branch, `archive/save-pre-reword` pinned `b3b41f5c`.
Against integration at `f7547b3bf`, it retains 51 commits and 2,849 blobs absent
from integration. Eight blobs have no other ref. The tag is the last
home for those eight blobs and must not be deleted.

Reflog expiry and object pruning remain pending until the final all-ref scan
lands. That scan confirms no credential blob is reachable. It also reconciles
the restart-era empty-object quarantine.

### The 2026-08-28 consolidation prune wave

The integration landed on `consolidate/final-history` (`5d98f3973`). The
gitignored valuables moved to the primary checkout. Every remaining
worktree was pruned: 102 worktrees removed, 100 branches deleted, each tip
tagged first. I exported dirty residue per worktree to
`~/Kinu-backups/worktree-residue/` as a tracked-diff patch plus an
untracked-files tarball before removal.

Novel-object counts against `consolidate/final-history` are dominated by the
pre-reroot history every old branch carries. The baseline history is short
after the two re-roots. The decisive column is SOLE COPY, measured with
the membership counter across all 239 refs on 2026-08-28. 69 of the 102 new
tags carry zero sole-copy objects. The 33 that do are listed. No tag is safe
to delete while its count is nonzero. After any tag deletion, re-measure.

| Tag | Branch (deleted) | Sole copy |
|---|---|---|
| `archive/landing-demos` | `motion/landing-demos` | 127 |
| `archive/mcts-grounding` | `fix/mcts-grounding` | 85 |
| `archive/landing-seam` | `scratch/landing-seam` | 61 |
| `archive/exploration-depth` | `verify/exploration-depth` | 57 |
| `archive/nimbus-long-process` | `fix/nimbus-long-process` | 47 |
| `archive/stack-agnostic` | `fix/stack-agnostic` | 44 |
| `archive/contradiction-sweep` | `docs/contradiction-sweep` | 43 |
| `archive/fork-verb` | `cutover/fork-verb` | 39 |
| `archive/swarm-node-hang` | `fix/swarm-node-hang` | 36 |
| `archive/prompt-surface` | `audit/prompt-surface` | 34 |
| `archive/test-quality` | `audit/test-quality` | 34 |
| `archive/ui-polish-followup` | `fix/ui-polish-followup` | 32 |
| `archive/numeric-bounds` | `audit/numeric-bounds` | 26 |
| `archive/stale-and-citations` | `chore/stale-and-citations` | 26 |
| `archive/platform-depth` | `test/platform-depth` | 24 |
| `archive/full-families` | `evals/full-families` | 21 |
| `archive/agent-class-dedup` | `refactor/agent-class-dedup` | 18 |
| `archive/core-extraction-2` | `core-extraction-2` | 18 |
| `archive/bench-polish` | `eval/bench-polish` | 16 |
| `archive/swarm-live` | `eval/swarm-live` | 15 |
| `archive/superseded-cleanup` | `docs/superseded-cleanup` | 15 |
| `archive/cli-suite-red` | `fix/cli-suite-red` | 14 |
| `archive/live-tier-proof` | `feat/live-tier-proof` | 13 |
| `archive/provability` | `gate/provability` | 9 |
| `archive/vfs-node-facet-wiring` | `feat/vfs-node-facet-wiring` | 7 |
| `archive/behaviour-assertions` | `eval/behaviour-assertions` | 5 |
| `archive/landing-no-proof` | `polish/landing-no-proof` | 4 |
| `archive/lean-citation-order` | `fix/lean-citation-order` | 4 |
| `archive/swarm-run-read-model` | `fix/swarm-run-read-model` | 4 |
| `archive/three-kinds-one-suite` | `test/three-kinds-one-suite` | 3 |
| `archive/tq-tui-behaviour` | `audit/tq-tui-behaviour` | 3 |
| `archive/archive-store` | `archive-store` | 3 |
| `archive/vfs-mounts` | `feat/vfs-mounts` | 1 |

The full 102-row manifest with head SHAs sits at `~/Kinu-backups/worktree-residue/prune-manifest-20260828.json`.
## Reproduce the test

`git filter-repo --mailmap` rewrote 2,242 commits. Measured 2026-08-21, none
of the nine tags is a `main` ancestor. Tree and blob SHAs remain comparable.

Blobs `main` lacks:

```sh
export LC_ALL=C
git rev-list --objects main   | cut -d' ' -f1 | sort -u > /tmp/main.objs
git rev-list --objects "$REF" | cut -d' ' -f1 | sort -u > /tmp/ref.objs
comm -23 /tmp/ref.objs /tmp/main.objs \
  | git cat-file --batch-check | awk '$2 == "blob"' | wc -l
```
Compare against `main`'s history, never its tip.

Blobs no other ref reaches:

```sh
export LC_ALL=C
git rev-list --objects --exclude="refs/tags/$REF" --all | cut -d' ' -f1 | sort -u > /tmp/others.objs
git rev-list --objects "$REF"                 | cut -d' ' -f1 | sort -u > /tmp/ref.objs
comm -23 /tmp/ref.objs /tmp/others.objs \
  | git cat-file --batch-check | awk '$2 == "blob"' | wc -l
```
Use `LC_ALL=C`. Locale sorting breaks `comm`. `--exclude` needs the full
refname. `--exclude="archive/$REF"` reports 0 sole copies. Measured 2026-08-21,
the short form reported 0 for all nine. The form above reports the table.

## Archived blobs I rejected

Six blobs are absent from `main`'s history, measured 2026-08-19. Read their
tag paths with `git cat-file -p <blob>`.

| Blob | Tag | Path inside the tag | Verdict |
|---|---|---|---|
| `127f460c` | `archive/latency-instrumentation` | `packages/cf-backend/src/orchestrator.ts` | Superseded by `70307e10` 88 minutes later; 29 branch-only `console.log` lines also fail anti-slop. |
| `4fa27d58` | `archive/stability-audit` | `docs/STABILITY-AUDIT.md` | 18-finding 2026-04-24 audit. Current source cites its IDs; its `file:line` pointers are stale. |
| `6a7dec61` `859726b7` `174d731b` `f6f19ee2` | `archive/stability-audit` | `docs/REQUIREMENTS-AUDIT.md`, four revisions | 2026-04-24 tracker contradicting current `workspace` architecture. It cites deleted `docs/EXECUTOR-V2.md` (two `main` commits still touch it) and pre-rewrite SHAs. |

The recovered A4 account is speculative. `core/src/platform-catalog.ts:2042`
claims a documented 100 s reap without a URL. Its 25-second heartbeat is at
`cf-backend/src/hooks/use-kinu.ts:1100`. Use `git <sha>:<path>` provenance.

AGENTS.md § Deploy Discipline retains `archive/nimbus-measure`'s 185-252 ms
Worker startup range. It was measured 2026-08-04 against Cloudflare's 1-second
startup limit. The tag also holds its 6,254.64 KiB gzip bundle reading.

The throwaway probe Worker remains tag-only:

```sh
git ls-tree -r --name-only archive/nimbus-measure | grep -E \
  'spike-nimbus-probe/|packages/cf-backend/src/nimbus-measure.ts|packages/cf-backend/scripts/merge-nimbus-assets.mjs'
```
