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
 * WHY THIS IS ITS OWN GATE AT PUSH TIER RATHER THAN A TEST AT CI. The check is
 * 159 `git apply --check` invocations, measured at 0.15s over the whole corpus —
 * below `preflight` (0.12s) in the same order and two orders below `bun run
 * check`. Held at ci, the author of the breaking refactor learns after pushing,
 * which is exactly how all 16 re-anchors to date happened: a separate `bench:
 * re-anchor …` commit landing after the change that caused it. At commit tier the
 * breaking change fails on the machine that made it, before the code leaves it,
 * while the person who moved the code is still holding it. Push rather than commit
 * only because the commit tier's 15s budget has 0.5s of honest headroom and a stale
 * patch is fully recoverable one tier later.
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
import { benchPatchFiles, stalePatches } from './bench-corpus';
import { assertMeasured, finding } from './gate-ratchet';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

function main(): number {
  const files = benchPatchFiles();
  const stale = stalePatches(REPO_ROOT, files);
  const total = files.length;

  // The denominator BEFORE the verdict. A corpus that silently became empty
  // would otherwise report the healthiest possible number about a population
  // nobody looked at, which is the defect `assertMeasured` exists for.
  const measured = assertMeasured('bench-corpus', [
    ['tracked patch files checked', total],
  ]);

  if (stale.length === 0) {
    console.log(`bench-corpus: ok — ${measured}, every seeded defect still applies to this tree`);
    return 0;
  }

  for (const patch of stale) {
    console.error(finding({
      invariant: 'every seeded defect patch applies to the tree it will be measured against',
      at: patch.path,
      found: patch.detail,
      silently: patch.orphan
        ? 'no tasks.jsonl line names this patch, so no run applies it and no score depends on '
          + 'it — a half-finished retirement, which tests/bench/retired.jsonl exists to record'
        : 'the task becomes unrunnable and `prepare` throws OUTSIDE the per-attempt catch, so '
          + 'the next compare/gain/validate run dies mid-flight with no partial report',
      fix: patch.orphan
        ? 'finish the retirement — record it in tests/bench/retired.jsonl and delete the file '
          + '— or add back the tasks.jsonl line that measures it'
        : 're-anchor the hunk onto the code as it now stands, then PROVE it still injects the '
          + `defect: bun scripts/bench.ts validate --run-root <throwaway-dir> --id ${patch.id} `
          + '(one task, two attempts, measured at 93s, no model — against ~160 attempts for the '
          + 'whole corpus). `git apply --3way` may merge it for you, but merges '
          + 'cleanly on only 4 of 15 measured cases, so read the result before keeping it. If '
          + 'the code the defect was data about is GONE, retire it in tests/bench/retired.jsonl '
          + 'instead — but only after establishing that no live code still holds the property',
    }));
  }
  console.error(`bench-corpus: ${String(stale.length)} of ${String(total)} seeded patches no `
    + 'longer apply');
  return 1;
}

if (import.meta.main) process.exit(main());
