/**
 * FIRST RUN: an agent sees the computer's desktop and opens a window on it (D89, issue #100).
 *
 * THE DEFECT. The owner asked the agent to use the computer while its desktop was open in the Env panel. The agent
 * found no `DISPLAY`, installed Xvfb, started a second screen nobody could see, and could not read the PNG it took.
 *
 * THE ASSERTION, hard: one program looks at the screen the owner watches, starts a page in the computer's own
 * browser from its shell, waits for the window, and returns the screen. The model is handed that screen as an image,
 * 1280×768 by the PNG's own header; and the box itself names the page's window on its display.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { firstRunSpliceStep, firstRunTurnEvents } from './turn-settlement';
import { DESKTOP_ASK as ASK, DESKTOP_PROBE_TITLE } from './asks';
import type { RunEvent } from '../../packages/core/src/index';
import { ImageCarrierSchema } from '../../packages/core/src/types/tool-images';

const SUITE = 'First-run · computer-desktop';

const CASE = 'computer-desktop' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const isToolCallEnd = (event: RunEvent): event is ToolCallEnd => event.type === 'tool_call_end';

/** A PNG's size, from its header; null for bytes that are no PNG. */
function pngSize(base64: string): { readonly width: number; readonly height: number } | null {
  const bytes = Buffer.from(base64, 'base64');

  if (bytes.length < 24 || bytes.toString('latin1', 1, 4) !== 'PNG') return null;

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, { timeout: 12 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      purpose: 'A terse assistant that runs the program it is given and reports what it returns.',
      // A fresh box starts, then its desktop, then a browser.
      budgetMs: 10 * 60_000,
      async run({ session }) {
        const landing = await session.prompt(ASK);

        const calls = firstRunTurnEvents(await session.runEvents(), ASK, {
          splicedAtStep: firstRunSpliceStep(await session.history(), ASK),
          absorbedBy: landing.landed === 'mid-turn' ? landing.absorbedBy : undefined,
        }).filter(isToolCallEnd);

        const program = calls.find((call) => call.name === 'eval');
        const carried = v.safeParse(ImageCarrierSchema, program?.result);
        const images = carried.success ? carried.output.images : [];
        const [shot] = images;
        const size = shot === undefined ? null : pngSize(shot.data);
        const window = await session.execute('computer', `xdotool search --name ${DESKTOP_PROBE_TITLE} || true`);

        return [
          {
            what: 'screen-shown-to-the-model',
            reached: images.length === 1 && shot?.mediaType === 'image/png' && size?.width === 1280 && size.height === 768,
            detail: program === undefined
              ? 'no eval call ran the program in this turn'
              : `the program's result carried ${String(images.length)} image(s), the first ${JSON.stringify(size)}: ${JSON.stringify(program.result ?? program.error).slice(0, 300)}`,
          },
          {
            what: 'window-on-the-screen',
            reached: window.exitCode === 0 && (window.stdout ?? '').trim() !== '',
            detail: `xdotool search --name ${DESKTOP_PROBE_TITLE} on the computer answered ${JSON.stringify(window).slice(0, 300)}`,
          },
        ] satisfies EvalSubgoal[];
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
