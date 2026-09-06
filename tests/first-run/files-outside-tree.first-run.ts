/**
 * FIRST RUN: opening a file gives you the file.
 *
 * THE DEFECT. The owner opened a hosted file in the Files tab and got EIO,
 * carrying the Workers runtime's own sentence: "Code generation from strings
 * disallowed for this context". The pane's read is a bounded PREVIEW, the
 * preview goes through the plane's ranged read, and the origin session's ranged
 * read ran `node -e <a one-line CJS reader>` through the box's exec. `node -e`
 * compiles its source with `new Function`, which workerd forbids outright.
 *
 * WHY EVERY GATE STAYED GREEN. Every suite that touched that path ran under
 * Node or bun, where `new Function` is ordinary. The ban is a property of the
 * RUNTIME THE PRODUCT IS DEPLOYED ON, so no amount of testing off that runtime
 * could see it — the fix landed with a workerd-pool proof for exactly that
 * reason, and this case is the deployed half of the same claim.
 *
 * WHY A PATH OUTSIDE THE WORKSPACE TREE. Under `/home/user` the workspace's own
 * overlay can serve a read; an absolute path elsewhere is the ORIGIN SESSION's
 * filesystem, which is the plane whose ranged read was broken. So the case
 * writes its own file at a known absolute path outside the tree, with bytes it
 * chose, and asks the pane for it.
 *
 * THE ASSERTIONS, all hard: the pane answers with CONTENT and not an error, the
 * content is byte-for-byte what this file wrote, and the answer names neither
 * EIO nor the codegen refusal. The last one is not redundant: a future read that
 * fails differently should fail this case with its own words rather than being
 * mistaken for the defect this row is named after.
 */
import { afterAll, describe, test } from 'vitest';

import type { EvalObservation } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
  type FirstRunSubgoal,
} from './first-run';

const SUITE = 'First-run · files-outside-tree';
const CASE = 'files-outside-tree' as const;

/** The executor whose filesystem a hosted workspace lives on — the plane the
 *  Files tab reads, spelled as the pane spells it. */
const PLANE = 'workspace';

/**
 * A path OUTSIDE `/home/user`, which is what routes the read to the origin
 * session rather than to the workspace overlay. `/tmp` because every box has
 * one and nothing else on the deployment owns this name.
 */
const OUTSIDE = `/tmp/kinu-first-run-${String(Date.now())}.txt`;

/**
 * The bytes, chosen here.
 *
 * Multi-line and not a round number of bytes, because the read is a WINDOW: a
 * one-line file cannot tell a correct range read from one that returned
 * everything, and the defect lived in the ranged path.
 */
const BYTES = [
  'KINU_FIRST_RUN_FILE_OK',
  'second line, so the preview is a window over more than one',
  'third line ends without a trailing newline',
].join('\n');

/** The refusal this row is named after, in the runtime's own words. */
const CODEGEN_REFUSAL = 'Code generation from strings';

const PLAN = firstRunCasePlan(SUITE, CASE);
const liveTest = test.skipIf(PLAN === null);
const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'none',
      purpose: 'A workspace whose files a person opens.',
      async run({ session }) {
        // Written through the workspace's own shell rather than the files
        // route: the route writes into the workspace tree, and the whole point
        // of this case is a path that is not in it. A heredoc, so the bytes
        // arrive exactly as written with no shell interpretation.
        const written = await session.execute(
          PLANE,
          `cat > ${JSON.stringify(OUTSIDE)} <<'KINU_FIRST_RUN_EOF'\n${BYTES}\nKINU_FIRST_RUN_EOF`,
        );

        const viewed = await session.viewFile(PLANE, OUTSIDE);
        const content = viewed.content ?? '';
        const error = viewed.error ?? '';

        return [
          {
            what: 'seeded',
            reached: (written.exitCode ?? 0) === 0 && (written.error ?? '') === '',
            detail: `writing ${OUTSIDE} on the ${PLANE} plane answered exit `
              + `${String(written.exitCode ?? 0)}${written.error === undefined ? '' : `: ${written.error}`}`,
          },
          {
            what: 'bytes-came-back',
            reached: content.includes(BYTES),
            detail: error !== ''
              ? `the Files tab could not read a path outside the workspace tree: ${error}`
              : `the pane answered ${String(content.length)} character(s): `
                + JSON.stringify(content.slice(0, 200)),
          },
          {
            what: 'never-eio',
            reached: !error.includes('EIO') && !error.includes(CODEGEN_REFUSAL),
            detail: error === ''
              ? 'the read raised nothing'
              : `the read failed, and its own words were: ${error}`,
          },
        ] satisfies FirstRunSubgoal[];
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
