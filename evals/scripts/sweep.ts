// The eval run's first step (`bun run evals`), once per run before any task file loads: every `eval-` workspace on the
// run's account that no run still marks live, and no one holds, is deleted (`evals/src/sweep.ts`). Every task file
// runs at once, so a sweep in each file's `beforeAll` swept one account nine times at once: on 2026-10-01 eight of them
// were refused the same first delete, threw, and skipped every trial of their tasks. A delete the deployment fails is
// printed with its reason and the run goes on; an account that cannot be listed fails the run here, loudly.
//   bun evals/scripts/sweep.ts
import { deleteWorkspace, listWorkspaces } from '../src/session';
import { heldWorkspaces, sweepEvalWorkspaces } from '../src/sweep';
import { resolveEvalTarget } from '../src/target';

const target = resolveEvalTarget(process.env);

const swept = await sweepEvalWorkspaces({
  list: () => listWorkspaces(target.origin, target.identity),
  remove: (name) => deleteWorkspace(target.origin, target.identity, name),
  held: heldWorkspaces(target.origin),
  now: Date.now(),
});

console.warn(`[evals] ${target.origin}: deleted ${String(swept.deleted.length)} eval workspace(s) no run still marks live`
  + `${swept.deleted.length === 0 ? '' : ` (${swept.deleted.join(', ')})`}; ${String(swept.live.length)} marked live`
  + `${swept.held.map(({ name, reason }) => `; ${name} held: ${reason}`).join('')}`);

for (const { name, reason } of swept.failed) console.warn(`[evals] ${target.origin}: ${name} is left behind, its delete failed: ${reason}`);
