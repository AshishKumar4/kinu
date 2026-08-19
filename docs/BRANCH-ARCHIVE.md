# Branch Archive — what makes a branch safe to delete

> Maintained by Claude (AI-edited documentation, presented as-is); verify against
> the tags themselves when precision matters.

Some unmerged branches hold file content that exists nowhere in `main`'s history.
Deleting those branches is safe only because an `archive/*` tag pins the same
commits, and nothing in the repository recorded which tag covered which branch.
A prune that deleted a tag it did not know was load-bearing would destroy
content silently. No test fails, no gate fires, the blobs simply become
unreachable and the next `git gc` collects them.

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

Eight tags live under `refs/tags/archive/`. All eight are lightweight tags on a
commit. Both counts below were measured on 2026-08-19 against `main` at
`5dbc0f1b`, with the commands in the next section.

- **Blobs `main` lacks** counts blobs reachable from the tag that no commit in
  `main`'s history holds. This is the durable question, because branches get
  pruned and `main`'s history does not.
- **Sole copy** counts blobs that no other ref in the repository reaches. This
  number falls as work lands and rises as branches are pruned, so re-measure it
  rather than trusting the figure here.

| Tag | Commit | Commits | Blobs `main` lacks | Sole copy |
|---|---|---|---|---|
| `archive/agents-sdk` | `00d7d0e9` | 917 | 372 | 4 |
| `archive/chat-pagination` | `aa8e4d03` | 1714 | 1560 | 0 |
| `archive/do-resilience` | `8468735c` | 1133 | 606 | 24 |
| `archive/latency-instrumentation` | `21dc6d44` | 43 | 1 | 0 |
| `archive/nimbus-measure` | `dc02ef08` | 917 | 382 | 14 |
| `archive/one-filesystem-mounts` | `98c4f285` | 1469 | 1323 | 0 |
| `archive/pre-reroot` | `8e98574c` | 1529 | 1291 | 0 |
| `archive/stability-audit` | `1a1c9341` | 229 | 14 | 0 |

Every tag has a nonzero novel-blob count, so by the rule above no archive tag is
safe to delete today. The counts are large because `main` was re-rooted. It now
carries 982 commits from a single root, so the pre-rewrite history these tags sit
on is not in it, and every intermediate revision on those branches counts as a
blob `main` never held. `archive/pre-reroot` is no exception. It preserves the
commit graph and authorship of the history that `git filter-repo --mailmap`
rewrote, and it also holds 1,291 blobs `main`'s history no longer reaches.

Four tags name the branch they pin. The other four record only their tip commit
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

## Reproducing the test

Ancestry answers nothing here. `git filter-repo --mailmap` rewrote 2,242
commits, so no pre-rewrite branch is an ancestor of `main`, and that says
nothing about content. Measured 2026-08-19: none of the eight tags is an
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
`main` ever held those bytes, not whether it holds them now.

Blobs no other ref reaches, for one tag:

```sh
export LC_ALL=C
git rev-list --objects --exclude="$REF" --all | cut -d' ' -f1 | sort -u > /tmp/others.objs
git rev-list --objects "$REF"                 | cut -d' ' -f1 | sort -u > /tmp/ref.objs
comm -23 /tmp/ref.objs /tmp/others.objs \
  | git cat-file --batch-check | awk '$2 == "blob"' | wc -l
```

`LC_ALL=C` matters. `comm` compares bytes, so a locale-collated `sort` feeds it
input it reads as unsorted and the answer is wrong without warning.

## What was read and judged, and why none of it was landed

Six blobs were read in full and judged on content. All six are absent from
`main`'s history, measured 2026-08-19. None was worth landing.

**None of the paths in the table below exists in the working tree.** Each one
names a path inside the tag. Read one with `git cat-file -p <blob>`; a checkout
will not find it.

| Blob | Tag that reaches it | Path inside the tag | Verdict |
|---|---|---|---|
| `127f460c` | `archive/latency-instrumentation` | `packages/cf-backend/src/orchestrator.ts` | Superseded, proven. The only source file in the set. Its commit added first-chunk latency instrumentation through `console.log`. `main`'s own `70307e10`, an ancestor of `main` 88 minutes later, landed the same feature through a trace helper that also broadcasts to the UI, plus three more trace points. The whole diff is 29 branch-only lines, every one a `console.log` timing call. The feature lives today at `cf-backend/src/actor-agent.ts:3210`, which calls `onFirstChunk()` at `core/src/orchestrator/turn-accumulator.ts:182`. Landing the branch version would also regress the anti-slop gate: it carries an empty `catch` and `(err as Error).message`. |
| `4fa27d58` | `archive/stability-audit` | `docs/STABILITY-AUDIT.md` | Superseded snapshot. A real 18-finding forensic audit from 2026-04-24, and its findings landed. `main`'s source cites the audit's finding IDs by name: A1, A2, A3 and D5 in `cf-backend/src/hooks/use-proteus.ts` (`:564`, `:620`, `:768`, `:1174`), A1 and D2 in `cf-backend/src/pages/WorkspacePage.tsx`, D2 in `cf-backend/src/components/ErrorBoundary.tsx`, B4 in `cf-backend/src/orchestrator.ts:3030`, and B2/B3 in `core/src/execution/sandbox.ts:86`. The audit's own `file:line` citations are months stale, so landing it would ship a document whose every pointer is wrong. |
| `6a7dec61` `859726b7` `174d731b` `f6f19ee2` | `archive/stability-audit` | `docs/REQUIREMENTS-AUDIT.md`, four revisions | Superseded session bookkeeping, and now contradictory. A per-conversation request tracker from 2026-04-24. Item 9 records Nimbus as deferred and item 11 asks to remove `workspace` from the user-facing executor list, which inverts the current architecture where `workspace` is the one canonical file and execution plane. It also cites `docs/EXECUTOR-V2.md`, deleted from the working tree; two commits in `main`'s history still touch that path, so that one file needs no tag to recover. The tracker cites pre-rewrite SHAs that are not `main` ancestors as well. Landing it would assert false current state. |

The A4 finding is the one case where the code itself records the loss.
`cf-backend/src/hooks/use-proteus.ts:634-643` ships a 25-second WebSocket
heartbeat and says in the comment that the `STABILITY-AUDIT §A4` it used to cite
is not in the working tree, that only the recovered text survives, and that the
figure the recovered text asserts is uncited. `core/src/platform-catalog.ts:1940`
carries the same provenance under `edge.websocket_idle_reap_ms`, labelled
SPECULATIVE, and `scripts/platform-catalog.ts` fails any provenance string that
points at the deleted file.

`archive/nimbus-measure` is the one tag where a single file was worth keeping:
its measurement write-up. That write-up is deliberately out of this repository.
It went with the other internal design records, and its load-bearing figures
were carried into AGENTS.md § Deploy Discipline first: the 185-252 ms Worker
startup range measured 2026-08-04 against Cloudflare's 1-second startup limit,
and the 6,254.64 KiB gzip bundle reading of the same date that later readings
are compared against. Both stand there on their own dates.

The throwaway probe Worker beside it was left tag-only on purpose. None of
`spike-nimbus-probe/`, `packages/cf-backend/src/nimbus-measure.ts` or
`packages/cf-backend/scripts/merge-nimbus-assets.mjs` exists in the working
tree. All three are in `archive/nimbus-measure`.
