# Branch Archive — what makes a branch safe to delete

> Maintained by Claude (AI-edited documentation, presented as-is); verify against
> the tags themselves when precision matters.

Some unmerged branches hold file content that exists nowhere in `main`'s history.
Deleting those branches is safe only because an `archive/*` tag pins the same
commits, and **nothing in the repository recorded which tag covered which
branch.** A prune that deleted a tag it did not know was load-bearing would
destroy content silently — no test fails, no gate fires, the blobs simply become
unreachable and the next `git gc` collects them.

This file is that record. It exists so the mapping cannot be lost, not because
archive tags are interesting.

## The rule

**Never delete a tag under `refs/tags/archive/` without re-running the test
below and getting a novel-blob count of zero.** A tag with a nonzero count is the
only remaining home for that content. Tags are cheap; the content is not
reproducible.

Deleting the *branch* is the safe operation. Deleting the *tag* is the dangerous
one, and they look equally harmless in a prune script.

## Tag → branch recoverability

Blob counts are objects reachable from the tag that no commit in `main`'s
history holds, measured 2026-08-18 against `main` at `17318b3f`.

| Tag | Commit | Pins the tip of | Blobs `main` lacks | Load-bearing |
|---|---|---|---|---|
| `archive/one-filesystem-mounts` | `98c4f285` | `feat/one-filesystem` | **57** | **YES** — the only copy |
| `archive/nimbus-measure` | `dc02ef08` | `spike/nimbus-measure` | **14** | **YES** — the only copy |
| `archive/stability-audit` | `1a1c9341` | `feat/agent-view-redesign` | **5** | YES — second copy on `worktree-proteus-v2-runtime` |
| `archive/latency-instrumentation` | `21dc6d44` | `fix/latency-instrumentation` | **1** | **YES** — the only copy |
| `archive/pre-reroot` | `8e98574c` | (no branch; pre-rewrite history) | **0** | No — graph and authorship only |

`archive/pre-reroot` is the one exception worth understanding: it makes 1,529
commits reachable but contributes **zero** unique blobs. It preserves the commit
graph and authorship of the history that `git filter-repo --mailmap` rewrote, not
content. Losing it loses provenance, not code.

The other four each carry content, and three of them are the sole copy. In
particular `archive/one-filesystem-mounts` holds `packages/core/src/index.ts`,
`packages/core/src/safety/approval-gate.ts`,
`packages/core/src/types/agent-runtime.ts` and
`packages/cf-backend/src/runtime.ts` — core source, not documentation. The
`feat/one-filesystem` design was rejected deliberately (AGENTS.md § Execution
Layer, and `packages/cli-backend/tests/mount-plane.test.ts` enforces the
rejection), so the branch is safe to delete; the tag is not.

## Reproducing the test

Ancestry is useless here. `git filter-repo --mailmap` rewrote 2,242 commits, so
no pre-rewrite branch is an ancestor of `main` and that says nothing about
content. The exploitable invariant is that `--mailmap` rewrites *commit* objects
only — tree and blob SHAs are untouched, so content identity survives the rewrite
and compares cleanly across it.

```sh
git rev-list --objects main       | cut -d' ' -f1 | sort -u > /tmp/main.objs
git rev-list --objects "$REF"     | cut -d' ' -f1 | sort -u > /tmp/ref.objs
comm -23 /tmp/ref.objs /tmp/main.objs \
  | git cat-file --batch-check | awk '$2 == "blob"' | wc -l
```

Compare against `main`'s whole history, never its tip: the question is whether
`main` ever held those bytes, not whether it holds them now.

## What the archived content is, and why none of it was landed

Across the 77 pre-rewrite branches, exactly **six** blobs exist nowhere in
`main`'s history. Each was read and judged on content; none was worth landing.

| Blob | Path | Verdict |
|---|---|---|
| `127f460c` | `packages/cf-backend/src/orchestrator.ts` | **Superseded, proven.** The only source file in the set. Its commit added first-chunk latency instrumentation via `console.log`; `main`'s own `70307e10` — an ancestor of `main`, 88 minutes later — landed the same feature through a `_trace()` helper that also broadcasts to the UI, plus three more trace points. The whole diff is 29 branch-only lines, every one a `console.log` timing call. The feature lives today at `actor-agent.ts:3012` → `turn-accumulator.ts:182`. Landing it would also regress the anti-slop gate: it carries an empty `catch` and `(err as Error).message`. |
| `4fa27d58` | `docs/STABILITY-AUDIT.md` | **Superseded snapshot.** A real 18-finding forensic audit from 2026-04-24, and its findings landed — `main`'s source cites the audit's own finding IDs by name (`use-proteus.ts:615` for A2, `:647` for A4, plus A1/A3/A5/D2/D5). Its `file:line` citations are months stale, so landing it would ship a document whose every pointer is wrong. |
| `6a7dec61` `859726b7` `174d731b` `f6f19ee2` | `docs/REQUIREMENTS-AUDIT.md` ×4 revisions | **Superseded session bookkeeping, and now contradictory.** A per-conversation request tracker from 2026-04-24. Item 9 records Nimbus as deferred and item 11 as "remove workspace from the user-facing executor list" — the inverse of the current architecture, where `workspace` is the one canonical file and execution plane. It also cites `docs/EXECUTOR-V2.md`, deleted, and pre-rewrite SHAs that are not `main` ancestors. Landing it would assert false current state. |

The one exception is `spike/nimbus-measure`, where a single file *was* worth
keeping: its measurement write-up. That write-up is deliberately out of this
repository — it went with the other internal design records — and its
load-bearing figures were carried into `AGENTS.md` § Deploy Discipline before it
went: the 185–252 ms startup range against Cloudflare's 1-second limit, and the
2026-08-04 gzip reading the later one is compared against. Both stand there on
their own dates. The throwaway probe Worker beside it (`spike-nimbus-probe/`,
`packages/cf-backend/src/nimbus-measure.ts`, `merge-nimbus-assets.mjs`) was
deliberately left tag-only.
