# Branch Archive: what makes a branch safe to delete

Some unmerged branches hold file content that exists nowhere in `main`'s history.
Deleting those branches is safe only because an `archive/*` tag pins the same
commits, and nothing in the repository recorded which tag covered which branch.
A prune that deleted a tag it did not know was load-bearing would destroy
content silently. No test fails, no gate fires, the blobs become unreachable
and the next `git gc` collects them.

This file is that record. It exists so the mapping cannot be lost, not because
archive tags are interesting.

## The rule

Never delete a tag under `refs/tags/archive/` without re-running the test below
and getting a novel-blob count of zero. A tag with a nonzero count is the only
remaining home for that content. Tags are cheap and the content is not
reproducible.

Deleting the *branch* is the safe operation. Deleting the *tag* is the dangerous
one, and the two look equally harmless in a prune script.

## Tag inventory

Forty tags live under `refs/tags/archive/`. All are lightweight tags on a
commit. Thirty-one were added by the 2026-08-21 prune wave and carry their own
table below. Both counts for the first nine were measured on 2026-08-21
against `main` at `29f654bd`, with the commands in the next section; the wave
table was measured the same day against `main` at `c143c4b6`.

- **Blobs `main` lacks** counts blobs reachable from the tag that no commit in
  `main`'s history holds. This is the durable question, because branches get
  pruned and `main`'s history does not.
- **Sole copy** counts blobs that no other ref in the repository reaches. This
  number falls as work lands and rises as branches are pruned, so re-measure it
  rather than trusting the figure here.

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

Every tag has a nonzero novel-blob count, so by the rule above no archive tag is
safe to delete today. The counts are large because `main` has been re-rooted
twice: each rewrite replaced its history with a fresh single-root line (982
commits after the first, 84 measured 2026-08-21 after the second), so the
pre-launch history these tags sit on is not in it, and every intermediate
revision on those branches counts as a blob `main` never held. The second
rewrite is why every count in the table is larger than its 2026-08-19 reading.
`archive/pre-reroot` is no exception. It preserves the commit graph and
authorship of the history that `git filter-repo --mailmap` rewrote, and it holds
5,062 blobs `main`'s history no longer reaches.

Four tags name the branch they pin. The other five record only their tip commit
and its subject, and the branch name was never written down.

| Tag | Pins the tip of |
|---|---|
| `archive/one-filesystem-mounts` | `feat/one-filesystem` (branch still present) |
| `archive/nimbus-measure` | `spike/nimbus-measure` (branch deleted) |
| `archive/stability-audit` | `feat/agent-view-redesign` (branch deleted) |
| `archive/latency-instrumentation` | `fix/latency-instrumentation` (branch deleted) |

The `feat/one-filesystem` design was rejected deliberately (AGENTS.md
§ Execution Layer, and `packages/cli-backend/tests/mount-plane.test.ts` enforces
the rejection), so that branch is safe to delete. Its tag is not.

`archive/pre-launch-history` pins no branch. It pins the tip `main` itself sat
on until 2026-08-20, when a reset moved `main` back to `7cfdd992` and the
history rewrite that followed left the old line unreachable. The tag is the only
ref that still reaches that line: 1,149 commits `main` lacks, the 2026-08-19
measurement base `5dbc0f1b` among them, and — measured during the 2026-08-20
prune wave — the tips of 60+ working branches since deleted. It is the most
load-bearing tag in this table: 307 of its blobs exist nowhere else.

### The 2026-08-21 prune wave

Thirty-one branches were judged against `main` on content and deleted, each
behind a tag created and verified before the delete. Every tag pins the tip of
the branch named in it, minus the type prefix (`fix/reliability-a1a3` pins as
`archive/reliability-a1a3`). Counts were measured against `main` at
`c143c4b6`. Sole copy is 0 for every row: these branches share their whole
pre-rewrite commit graph with surviving siblings, so no blob is exclusively
theirs. The novel-blob count is what makes each tag load-bearing.

| Branch (deleted) | Tag | Commit | Commits | Blobs `main` lacks | Sole copy |
|---|---|---|---|---|---|
| `chore/kinu-rename` | `archive/kinu-rename` | `074ad285` | 1049 | 4523 | 0 |
| `proof/fabric-v2-port` | `archive/fabric-v2-port` | `7f47f958` | 1049 | 4411 | 0 |
| `fix/d1-removal-kv-auth` | `archive/d1-removal-kv-auth` | `6863c622` | 1089 | 4439 | 0 |
| `bench/tbench-run-3` | `archive/tbench-run-3` | `ec7baac5` | 1088 | 4409 | 0 |
| `chore/commit-hygiene-gate` | `archive/commit-hygiene-gate` | `ef3e9a70` | 845 | 4198 | 0 |
| `gate/patch-parity` | `archive/patch-parity` | `0b4f1064` | 845 | 4197 | 0 |
| `cutover/settle-mcts` | `archive/settle-mcts` | `dd81adcb` | 1871 | 5933 | 0 |
| `feat/agent-nodes` | `archive/agent-nodes` | `7a0598b6` | 846 | 4194 | 0 |
| `feat/agents-swarm` | `archive/agents-swarm` | `8a464199` | 1839 | 5902 | 0 |
| `feat/node-substrate` | `archive/node-substrate` | `7d1cbea9` | 1885 | 5946 | 0 |
| `feat/records-judge` | `archive/records-judge` | `b8fb9f05` | 871 | 4214 | 0 |
| `feat/swarm-depth` | `archive/swarm-depth` | `b19c36f5` | 1869 | 5932 | 0 |
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

The judgment that sent each branch here came from its shipped successor, not
from its name: the strategy branches land in `packages/core/src/strategy/`,
the antislop branches in `tools/oxlint/anti-slop/`, the KV auth cutover in
`packages/cf-backend/src/auth/store.ts`, the commit-hygiene gate in
`scripts/commit-hygiene.ts`. Branches with no traced landing evidence were not
touched; they wait on an owner ruling.

`archive/reliability-a1a3` is the one tag that pins a commit made during the
prune rather than a bare branch tip. Its worktree held a crashed
`git worktree add` from 2026-08-10: a stale `index.lock`, no index, and 272 of
1,179 files checked out, every one byte-identical to its blob in the branch
tip `df014c73`. That crash state was committed verbatim, and the tag holds the
commit whose parent is `df014c73`, so both the snapshot and the record of what
the crash left behind stay reachable. The branch's own work had landed long
before: `packages/cf-backend/src/hooks/use-kinu.ts` cites STABILITY-AUDIT §A1
and §A3 by name.

## Reproducing the test

Ancestry answers nothing here. `git filter-repo --mailmap` rewrote 2,242
commits, so no pre-rewrite branch is an ancestor of `main`, and that says
nothing about content. Measured 2026-08-21: none of the nine tags is an
ancestor of `main`. The exploitable invariant is that `--mailmap` rewrites
*commit* objects only. Tree and blob SHAs are untouched, so content identity
survives the rewrite and compares cleanly across it.

Blobs `main` lacks, for one tag:

```sh
export LC_ALL=C
git rev-list --objects main   | cut -d' ' -f1 | sort -u > /tmp/main.objs
git rev-list --objects "$REF" | cut -d' ' -f1 | sort -u > /tmp/ref.objs
comm -23 /tmp/ref.objs /tmp/main.objs \
  | git cat-file --batch-check | awk '$2 == "blob"' | wc -l
```

Compare against `main`'s whole history, never its tip. The question is whether
`main` ever held those bytes.

Blobs no other ref reaches, for one tag:

```sh
export LC_ALL=C
git rev-list --objects --exclude="refs/tags/$REF" --all | cut -d' ' -f1 | sort -u > /tmp/others.objs
git rev-list --objects "$REF"                 | cut -d' ' -f1 | sort -u > /tmp/ref.objs
comm -23 /tmp/ref.objs /tmp/others.objs \
  | git cat-file --batch-check | awk '$2 == "blob"' | wc -l
```

`LC_ALL=C` matters. `comm` compares bytes, so a locale-collated `sort` feeds it
input it reads as unsorted and the answer is wrong without warning.

`--exclude` needs the FULL refname. A pattern holding a slash matches against
the whole refname, so `--exclude="archive/$REF"` matches nothing: the tag then
reaches itself through `--all` and the test reports a sole copy of 0 for every
tag, which reads as safe to delete. Measured 2026-08-21: the short form reported
0 for all nine tags; the form above reports the table.

## What was read and judged, and why none of it was landed

Six blobs were read in full and judged on content. All six are absent from
`main`'s history, measured 2026-08-19. None was worth landing.

**None of the paths in the table below exists in the working tree.** Each one
names a path inside the tag. Read one with `git cat-file -p <blob>`; a checkout
will not find it.

| Blob | Tag that reaches it | Path inside the tag | Verdict |
|---|---|---|---|
| `127f460c` | `archive/latency-instrumentation` | `packages/cf-backend/src/orchestrator.ts` | Superseded, proven. The only source file in the set. Its commit added first-chunk latency instrumentation through `console.log`. `main`'s own `70307e10`, an ancestor of `main` 88 minutes later, landed the same feature through a trace helper that also broadcasts to the UI, plus three more trace points. The whole diff is 29 branch-only lines, every one a `console.log` timing call. The feature lives today at `cf-backend/src/actor-agent.ts:4188`, which calls `onFirstChunk()` at `core/src/orchestrator/turn-accumulator.ts:190`. Landing the branch version would also regress the anti-slop gate: it carries an empty `catch` and `(err as Error).message`. |
| `4fa27d58` | `archive/stability-audit` | `docs/STABILITY-AUDIT.md` | Superseded snapshot. A real 18-finding forensic audit from 2026-04-24, and its findings landed. `main`'s source cites the audit's finding IDs by name: A1, A2, A3 and D5 in `cf-backend/src/hooks/use-kinu.ts` (`:635`, `:725`, `:926`, `:1339`), A1 and D2 in `cf-backend/src/pages/WorkspacePage.tsx`, D2 in `cf-backend/src/components/ErrorBoundary.tsx`, B4 in `cf-backend/src/orchestrator.ts:3073`, and B2/B3 in `core/src/execution/sandbox.ts:136`. The audit's own `file:line` citations are months stale, so landing it would ship a document whose every pointer is wrong. |
| `6a7dec61` `859726b7` `174d731b` `f6f19ee2` | `archive/stability-audit` | `docs/REQUIREMENTS-AUDIT.md`, four revisions | Superseded session bookkeeping, and now contradictory. A per-conversation request tracker from 2026-04-24. Item 9 records Nimbus as deferred and item 11 asks to remove `workspace` from the user-facing executor list, which inverts the current architecture where `workspace` is the one canonical file and execution plane. It also cites `docs/EXECUTOR-V2.md`, deleted from the working tree; two commits in `main`'s history still touch that path, so that one file needs no tag to recover. The tracker cites pre-rewrite SHAs that are not `main` ancestors as well. Landing it would assert false current state. |

The A4 finding is the one case where the code itself records the loss. The
25-second WebSocket heartbeat it justified still ships, at
`cf-backend/src/hooks/use-kinu.ts:832-845`, and that code no longer names A4.
The account of the loss sits in `core/src/platform-catalog.ts:1979`, under
`edge.websocket_idle_reap_ms`. That entry is labelled speculative, and its notes
record the whole chain: the heartbeat cited a bare `STABILITY-AUDIT §A4`, the
document is not in the working tree, only its recovered text survives, and the
recovered text asserts a documented 100 s reap while citing no URL.
`scripts/platform-catalog.ts:139` is what keeps that citation followable. It
refuses a provenance string naming a repo path that is gone, and accepts the
same path written `git <sha>:<path>`, because a pinned blob cannot drift.

`archive/nimbus-measure` is the only tag holding a file worth keeping, its
measurement write-up. That write-up is deliberately out of this repository.
It went with the other internal design records, and its load-bearing figures
were carried into AGENTS.md § Deploy Discipline first: the 185-252 ms Worker
startup range measured 2026-08-04 against Cloudflare's 1-second startup limit,
and the 6,254.64 KiB gzip bundle reading of the same date that later readings
are compared against. Both stand there on their own dates.

The throwaway probe Worker beside it was left tag-only on purpose. Its three
paths were deleted from the working tree, so read them out of the tag rather
than looking for them in a checkout:

```sh
git ls-tree -r --name-only archive/nimbus-measure | grep -E \
  'spike-nimbus-probe/|packages/cf-backend/src/nimbus-measure.ts|packages/cf-backend/scripts/merge-nimbus-assets.mjs'
```
