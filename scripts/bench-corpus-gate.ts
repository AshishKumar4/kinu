#!/usr/bin/env bun
/**
 * The bench corpus applicability gate: every seeded defect patch still applies.
 *
 * A defect patch is a context diff against source that keeps moving. When a
 * refactor renames or reflows the code a patch anchors on, the patch stops
 * applying and its task silently becomes unrunnable — `prepare` throws at attempt
 * time, and worse, it throws OUTSIDE the per-attempt try/catch, so one dead patch
 * aborts a whole `compare`/`gain`/`validate` run mid-flight with no partial report
 * (scripts/bench.ts:377 vs :390).
 *
 * WHY THIS IS ITS OWN GATE AT COMMIT TIER RATHER THAN A TEST AT CI. The check is
 * one `git apply --check` per seeded patch, measured at 0.34s over the whole
 * corpus (2026-09-23). Held at ci, the author of the breaking refactor learns
 * after pushing, which is exactly how all 16 re-anchors to date happened: a
 * separate `bench: re-anchor …` commit landing after the change that caused it.
 * Held at push, comment-only commits on 2026-09-22 broke 37 seeded patches and
 * committed cleanly. At commit tier the breaking change fails on the commit that
 * makes it, while the person who moved the code is still holding it.
 *
 * WHY NOT LOOSEN THE APPLY INSTEAD. Measured against each re-anchor commit's own
 * parent tree, over the 15 historical breakages: `git apply --3way` merges
 * CLEANLY on 4, and `-C2` fuzz applies on 5. (`--check --3way` reports success on
 * 10, which is the trap — it proves the pre-image is recoverable, not that the
 * merge is conflict-free, and the write then leaves conflict markers.) So
 * loosening rescues at most a third and is wrong twice over anyway. Mechanically,
 * the sandbox a patch really lands in excludes `.git` (bench-sandbox.ts
 * SANDBOX_EXCLUDES), so 3-way has no object database to recover a pre-image from
 * and 42 of the 159 patches carry no `index` line to name one. Substantively, a
 * fuzzed or merged defect is not the defect the task's `prompt` describes, and the
 * only thing that would notice is `bench.ts validate` — which runs nightly. That
 * trades a loud same-run failure for a silent change in what the benchmark
 * measures.
 *
 * So: strict apply, proven early, with the repair made cheap rather than
 * automatic. `bench.ts validate --id <id>` is the other half — it is what turns
 * "the patch applies again" into "the patch still breaks the checks", in one task
 * rather than 159.
 */
import { benchPatchFiles, corpusMembership, stalePatches } from './bench-corpus';
import { assertMeasured, finding } from './gate-ratchet';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

function main(): number {
  const files = benchPatchFiles(REPO_ROOT);
  const { tasks, orphans, unchecked } = corpusMembership(REPO_ROOT, files);
  const stale = stalePatches(REPO_ROOT, files);

  // The denominator BEFORE the verdict. A corpus that silently became empty
  // would otherwise report the healthiest possible number about a population
  // nobody looked at, which is the defect `assertMeasured` exists for.
  const measured = assertMeasured('bench-corpus', [
    ['tasks.jsonl tasks', tasks],
    ['tracked patch files checked', files.length],
  ]);

  const findings = [
    ...orphans.map((path) => finding({
      invariant: 'every tracked patch file is named by a tasks.jsonl line',
      at: path,
      found: 'no tasks.jsonl line names this patch',
      silently: 'no run applies it and no score depends on it, yet the patch count includes it — '
        + 'a half-finished retirement, which bench/corpus/retired.jsonl exists to record',
      fix: 'finish the retirement — record it in bench/corpus/retired.jsonl and delete the file '
        + '— or add back the tasks.jsonl line that measures it',
    })),
    ...unchecked.map((id) => finding({
      invariant: 'every tasks.jsonl line names a tracked patch file',
      at: `bench/corpus/patches/${id}.patch`,
      found: `task ${id} names a patch git does not track`,
      silently: 'this gate never checks it, and a fresh checkout cannot load the corpus: '
        + '`loadBenchCorpus` throws "missing defect patch" on every other machine',
      fix: `git add bench/corpus/patches/${id}.patch`,
    })),
    ...stale.map((patch) => finding({
      invariant: 'every seeded defect patch applies to the tree it will be measured against',
      at: patch.path,
      found: patch.detail,
      silently: 'the task becomes unrunnable and `prepare` throws OUTSIDE the per-attempt catch, so '
        + 'the next compare/gain/validate run dies mid-flight with no partial report',
      fix: 're-anchor the hunk onto the code as it now stands, then PROVE it still injects the '
        + `defect: bun scripts/bench.ts validate --run-root <throwaway-dir> --id ${patch.id} `
        + '(one task, two attempts, measured at 93s, no model — against ~160 attempts for the '
        + 'whole corpus). `git apply --3way` may merge it for you, but merges '
        + 'cleanly on only 4 of 15 measured cases, so read the result before keeping it. If '
        + 'the code the defect was data about is GONE, retire it in bench/corpus/retired.jsonl '
        + 'instead — but only after establishing that no live code still holds the property',
    })),
  ];

  if (findings.length === 0) {
    console.log(`bench-corpus: ok — ${measured}, one patch per task, every seeded defect still `
      + 'applies to this tree');

    return 0;
  }

  for (const text of findings) console.error(text);

  console.error(`bench-corpus: ${String(orphans.length)} orphan patch(es), ${String(unchecked.length)} `
    + `untracked task patch(es), ${String(stale.length)} of ${String(files.length)} seeded patches `
    + 'no longer apply');

  return 1;
}

if (import.meta.main) process.exit(main());
