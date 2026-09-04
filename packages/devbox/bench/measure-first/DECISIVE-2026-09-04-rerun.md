# Devbox storage strategies: the decisive rerun, 2026-09-04

> Run `kinu-devbox-bench-20260904142724`. Raw per-arm artifacts are under
> `bench-artifacts/20260904142724/` and the run-level artifact at
> `bench-artifacts/devbox-strategies-20260904142724.json`, on the box that ran
> it — raw trial evidence with its own retention, never committed (the ignore
> file states the rule). This report is what the tree keeps.

One five-arm comparison, deployed, on commit `9a0fe0c7f` with a clean tree
(`dirtyDigest: clean`), image `docker.io/cloudflare/sandbox@sha256:822501de…`,
seed 20260824, two repetitions per deciding cell. Started
2026-09-04T14:27:25Z, 42m47s wall. Worker versions per arm are in the
artifact's `identity` block. The relaunch of the run that
[refused its own admission on 2026-09-03](DECISIVE-2026-09-03.md), after the
three defects that run's driver recorded were closed.

**The fourth commit of that work (`dfe94eb68`, the whole-tree fence reader's
deletion) landed after this run started and is NOT in the measured tree.**
Everything below measures the three defect fixes only.

## What the run says outright

**RECOMMENDATION REFUSED.** The run failed admission, so nothing here ranks
anything. G0 (provenance) passes; G1–G9 refuse, with 4, 9, 5, 1, 16, 11, 5, 3
and 6 reasons. The instrument's own sentence: *"This run failed admission, so
ranking anything it measured would publish a claim the instrument cannot
support."*

That is the second refusal in two days, and it is not the same refusal. Every
arm got further than it did on 2026-09-03, three of the five now hold a wake,
and the three defects the previous driver recorded are closed with deployed
evidence. What refuses this run is a **different, later** set of failures — one
genuine new defect and two instrument defects — which the previous run never
survived long enough to expose.

## The five-column matrix

The conformance rows are carried unchanged from the 2026-09-03 report: this run
re-derived none of them. The local battery is green at 139 cells, one more than
before (the new partial-capture cell that the merge required). Only the
**deployed** rows are this run's.

| cell | snapshot-chain | r2fs | overlay-cas | bounded-layers | merkle-pack |
| --- | --- | --- | --- | --- | --- |
| 6.1 attach/write/commit/replace | existing | existing | existing | existing | existing |
| 6.2 quiesce publishes once | existing | existing | existing | existing | existing |
| 6.3 three generations wake whole | existing | existing | existing | existing | existing |
| 6.4 death at commit seams | existing | existing | existing | existing | existing |
| 6.5 fault at every await point | red-structural | red-structural | red-structural | pass | pass |
| 6.6 control metadata off payload prefix | existing | existing | existing | existing | existing |
| 6.7 corrupted payload refused | existing | existing | existing | existing | existing |
| 6.8 interrupted commit converges | existing | existing | existing | existing | existing |
| 6.9 DO reset mid-restore | pass | pass | pass | pass | pass |
| 6.10 racing containers | pass | red-structural | red-structural | pass | pass |
| 6.11 byte-for-byte fidelity | pass | pass | red-structural | pass | pass |
| 6.12 counted bounds k vs n vs 10n | red-bug | pass | red-bug | red-bug | pass |
| 6.13 1e5 files, RestoreWork flat | pass | pass | pass | red-bug | red-bug |
| 6.14 1 GiB sparse + 64 MiB dense | red-bug | red-structural | red-structural | red-bug | red-bug |
| 6.15 sqlite rewrite, dirty pages | red-bug | red-bug | red-bug | red-bug | pass |
| 6.16 teardown after stop | existing | existing | existing | existing | existing |
| 6.17 two containers, one head | pass | red-structural | red-structural | pass | pass |
| 6.18 disk full mid-journal | red-bug | red-bug | red-bug | red-bug | pass |
| 6.19 stop then wake, same instance | harness | harness | harness | harness | harness |
| 6.20 GC keeps reachable objects | pass | pass | pass | pass | pass |
| **deployed 2026-09-03** | **complete** | **refused at cold attach** | **failed mid-measurement** | **failed mid-measurement** | **failed mid-measurement** |
| **deployed 2026-09-04 (this run)** | **complete** | **failed at warm attach — the INSTRUMENT** | **failed at warm attach, attach overrun** | **failed at the wake, no published head** | **failed at the wake, no published head** |

## The deployed run, per arm

| arm | lifecycle proof | cold attach | ladder | wake | decisive ticks | ops tally |
| --- | --- | --- | --- | --- | --- | --- |
| `snapshot-chain` | PASSED (9/9) | 2,251 ms, `empty` | 6/6 rows | `attached` | 40 | 3,082 (A 2,836 / B 245) |
| `r2fs` | FAILED (7/8) | 3,362 ms, **`attached`** | 6/6, 6 committed | `attached` | 3 | none |
| `overlay-cas` | FAILED (9/10) | 3,822 ms, `empty` | 6/6, 5 committed | `attached` | 0 | none |
| `bounded-layers` | FAILED (2/3) | 3,519 ms, `empty` | 6/6, 3 committed | — | 0 | none |
| `merkle-pack` | FAILED (2/3) | 20,319 ms, `empty` | 6/6, 3 committed | — | 0 | none |

For `r2fs` and `overlay-cas` the ONLY failed check is `the arm completed every
measured step`. Every substantive check passed — the mount, the layers, the
marker surviving the recycle, the cursor. A reader scanning a column of
verdicts should not count either failure against the strategy without reading
the next two sections.

## The three defects, and what the deployed run says about each

### Defect 1 — the runner read v1 manifests from a v2 daemon. CLOSED.

Both candidate arms now publish. The check that recorded the defect reads, for
`bounded-layers`: `the first checkpoint MOVED bytes into the store: committed
moved=130574 held=129347B`, where 2026-09-03 recorded `moved=n/a held=0B`.
`merkle-pack`'s first quiesce moved 138,155 B.

Three generations landed per arm and the store proves it. The envelopes are
readable and each names its predecessor, with journal cuts growing exactly as
the 64 KiB / 4 MiB / 64 MiB ladder should:

| arm | gen 1 | gen 3 | gen 5 |
| --- | --- | --- | --- |
| `bounded-layers` | `7bc391ea…` cut 78, closure 7 | `8529b295…` cut 4,175, closure 16 | `f847532a…` cut 69,712, closure 145 |
| `merkle-pack` | `aa27bb62…` cut 78, closure 3 | `e60d8a22…` cut 4,175, closure 5 | `be182101…` cut 69,712, closure 22 |

### Defect 2 — r2fs cold attach refused to mount. CLOSED.

`r2fs` cold attach: **3,362 ms, `attached`**. On 2026-09-03 this arm died here
twice with `create failed: cold attach refused: /workspace could not be emptied
for a mount: Failed to change directory to '/var/tmp/devbox'` and measured
nothing at all. This run it attached, committed all six ladder rows, held its
stop and its wake, and measured three decisive ticks before the instrument
stopped it.

### Defect 3 — overlay-cas never settled. THE TERM IS NAMED AND FIXED; THE ARM STILL OVERRUNS LATER.

**The dominant term, from the previous run's own rows.** Its committing
checkpoints moved 0.05–1.98 MB/s, and the 64 MiB quiesce spent 67,723 ms across
roughly 132 store calls — about 513 ms each. The endpoint is not the bound:
`MEASUREMENTS.md` prices this same direct path at 95–146 MiB/s **with 16–64
requests in flight**. Every store call was awaited inside a `for`, so the arm
ran at one request and was bound by latency times call count. A fold issues one
tree write per changed path plus a read per blob it streams, which passes 25
minutes at about 2,000 changed files — and an npm tree is far larger. Not the
scan (the arm's own header measured that at 67 ms cold) and not a missing mount.

**What 16-wide in-step concurrency changed**, same cells, same seed:

| cell | 2026-09-03 | this run | change |
| --- | --- | --- | --- |
| 64 KiB quiesce | 5,350 ms | 3,383 ms | 1.58× |
| 4 MiB quiesce | 7,393 ms | 4,931 ms | 1.50× |
| 64 MiB quiesce | 67,723 ms | 37,855 ms | **1.79×** |
| 64 KiB tick | 845 ms | 90 ms | 9.39× |

And the arm now gets through work it never reached: the ladder, the stop, a
wake that attached, the pre-stop write surviving the recycle, decisive `npm`
repetitions 1 and 2, and `npm-excluded` — where 2026-09-03 died on its FIRST
decisive npm checkpoint at the 1,500,000 ms operation deadline.

**The crash ordering assertion still holds, and that is not incidental.** A
speedup with the ordering weakened would be worthless. Concurrency lives inside
one step and never across two: blobs before their batch, the batch before the
fold, the tree before the manifest, the manifest before the cursor, the cursor
before the reap are all boundaries between steps and each is still a single
await. In the fold only files and symlinks are pooled, because a hardlink reads
the manifest row its target's write puts there and `dir`/`delete` sweep the
manifest by prefix. The same tests that measure the overlap assert the order in
the same breath — one write in flight before the fix, sixteen after, and
`lastTree < manifest < cursor < reap` unchanged in both.

**What still refuses.** Later in the run, `overlay-cas`'s git and sqlite
segments were answered `a restoration has been running in the request for
268,111 ms`, and then: `[abandoned → refuse] Devbox.attach exceeded its
300000ms budget and was abandoned; the work it left running inside the
container cannot be fenced from here.` The restore of a large pending set still
outruns the arm's 300,000 ms attach budget. That is the arm's O(pending)
recovery cost, now **bounded and classified** rather than spinning until the
platform's store read path failed — which is what 2026-09-03 recorded, ending
in `GET cursor.json: HTTP 530`. The checkpoint half of that loop is fixed at
the source: a checkpoint joining an in-flight restoration now waits the
request's own budget and answers the readiness gate's re-askable sentence,
where before it awaited `pending.run` with no bound at all and held the
checkpoint lane past the driver's deadline.

The stale verify check that failed a healthy arm is also gone: `the tree lower
is present under its mounted store: /var/tmp/devbox/cas-store/tree under
/var/tmp/devbox/cas-store -> yes`.

## Defect 4 — a published head nothing can find. NEW, and defect 1 was masking it.

Both candidate arms fail the wake in the driver's words: `arm failed
mid-measurement: wake restored empty, expected attached`. This is not the old
failure. Before, an empty wake was CORRECT — nothing had been published, so
there was no head to restore. Now three generations are published per arm and
the wake still restores empty.

Asked rather than inferred, the box says which mechanism it is:

```
lastAttach = {"kind":"empty","detail":"candidate control has no published head"}
```

That is the host-side branch — the control head being null at
`ports.restoreState()` — not the restore runner answering `rootId: null`.

**The bytes landed; the pointer is lost.** All three envelopes per arm are
readable from the store with a consistent parent chain (above). The
`bounded-layers` bucket held 155 objects. So nothing reported success over work
that did not land, and the publish half of both candidate arms is sound.

Narrowing, from source and from the box:

- The head pointer is Durable-Object storage only, by design: the bucket holds
  three envelopes and no head object, and the runner's own test asserts no
  container-side control authority survives a run.
- Its key is stable — `devbox:candidate-control:<strategy>` — with no epoch and
  no boot id in it, so a stop cannot move it.
- `clearControl` is reachable only from `discard()`, which is box deletion.
- `replacedCount` is **0**: no container replacement lost it.
- `discard()` cannot have completed, because `discardState` deletes the
  last-attach row after it returns and that row survived — it is what quotes the
  refusal above.

So either the row is absent or it carries `head: null`, and
`readCandidateControl` makes the second representable: an absent row reads as
`{ head: null, operation: null }` ("an absent row is no history"), so any
transaction that reads the row absent writes that null back through
`freshOperation`, which preserves `current.head`. Separating those two needs the
raw control row, which no route exposes; a fixture route that dumps it is what
the next run should carry. I did not add one mid-run, and I did not re-run an arm
to manufacture the evidence.

**Evidence preserved before teardown closed the window**, at
`bench-artifacts/20260904142724/defect4-evidence/`: both boxes' `/state`
replies, all six envelopes whole, the store listing, and the read-only probe
that produced them. Teardown then verified clean — workers absent, buckets
empty, DO state empty, no multipart residue — so the resources are gone and the
evidence is not.

## The instrument's own defects, three of them today

Two are fixed in this tree; one is reported and left alone.

1. **The stale tree-lower check** (fixed). It asked for
   `/var/tmp/devbox/cas-lower`, the overlay's lower path until the arm moved the
   lower inside the store mount so a fold and the lower are one object, and it
   demanded a mount line of its own, which that layout deliberately does not
   have. It failed a healthy arm for three commits. Every layer path the proof
   restates is now declared in one block and compared against the constant its
   strategy declares.
2. **The v1 whole-tree read of a v2 fence** (fixed) — defect 1 above.
3. **The warm-attach expectation** (reported, NOT fixed). `r2fs` reached the
   warm attach and was failed by: `warm attach restored already-attached,
   expected attached`. `already-attached` is a legitimate product outcome and a
   step that admits only `attached` is narrower than the thing it measures. **The
   arm reached the warm attach and its failure was the instrument**, not the
   strategy.

## One measurement that is not trustworthy, stated rather than published

`overlay-cas`'s held-bytes column disagrees with the store by three orders of
magnitude. Its first checkpoint reports `moved=257648 held=1791B`, and the
ladder's held figures rise in near-constant ~196 B steps. A direct read-only
LIST of that arm's bucket after the run found **24,516 objects, 270.38 MB**
(blobs 193.66 MB, tree 75.77 MB, journal 6.08 MB, scan cache 4.24 MB), every one
of them under the single prefix `inventory()` lists — so the data is where the
metering looks, and the metering is what is wrong. Read the `moved` column for
this arm and disregard `held` until that is diagnosed.

## The incumbent reproduced itself, which is what makes the rerun comparable

`snapshot-chain` measured the same work within a few percent of 2026-09-03,
unchanged by any of this:

| workload | rep | Σ tick ms (this run) | Σ tick ms (2026-09-03) | bytes/rep |
| --- | --- | --- | --- | --- |
| npm | 1 | 32,626 | 34,165 | 244.1 MB |
| npm | 2 | 120,924 | 124,420 | 1,223.6 MB |
| npm-excluded | 1 | 35,121 | 33,333 | 244.1 MB |
| npm-excluded | 2 | 121,580 | 120,771 | 1,223.6 MB |
| git | 1 | 55,052 | 52,459 | 395.9 MB |
| git | 2 | 113,035 | 110,230 | 1,119.0 MB |
| sqlite | 1 | 122,544 | 119,147 | 1,199.5 MB |
| sqlite | 2 | 119,592 | 125,047 | 1,199.5 MB |

## Infrastructure observations, recorded rather than retried

- 2026-09-04T14:20:55Z — six R2 buckets from the 2026-08-31 runs are still on
  the account (`kinu-devbox-bench-20260831222710` and five
  `-20260831233915-*`). Not this run's, no collision with its ids, untouched.
- Teardown filed three `OperationInterruptedError: The sandbox container stopped
  while the operation was pending` against the two candidate boxes, and G8
  refuses on them. The cleanup checks nonetheless verified true afterwards:
  worker absent, buckets and multipart empty, box durable state empty, counters
  reconciled, replay idempotent, no local secrets or processes left.
- No account-level rate limit and no container-capacity refusal appeared. A
  staging deploy of the product sharing this account was possible for the whole
  window and no measurement was retried into a different one.
- One earlier launch of this same run (`20260904142055`) was killed by its
  launch method — a backgrounded shell job — after deploying two arms. It is not
  a measurement and is not reported as one; its 31 declared resources were swept
  by this run's own startup sweeper.

## What the next run needs

1. A fixture route that dumps the candidate control row, so defect 4's last
   question — row absent versus row carrying `head: null` — is answered by
   asking rather than by inference.
2. The warm-attach step widened to admit `already-attached`, which is a
   legitimate outcome of attaching a box that is already attached.
3. `overlay-cas`'s held-bytes metering diagnosed, or the column dropped for that
   arm rather than published wrong.
4. The restore of a large pending set brought under the attach budget, or the
   arm's `unbounded` restore class stated as the finding it is — G5 already
   refuses it: *"arm `overlay-cas` claims an unbounded restore class, which no
   durable arm may claim."*
