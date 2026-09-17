/**
 * FIRST RUN: a file written through the `/sandbox` mount is a file in the
 * container's working directory, and an empty path lists it.
 *
 * THE DEFECT. In the trajectory run public-failure-recovery (kinu.run at
 * b4d2c6001, run-6k2kglxfvqag1l0hwg8o8, 2026-09-14) the agent listed
 * `/sandbox/workspace` — empty — then asked the file tool to write
 * `/sandbox/workspace/broken.mjs` and was refused `io`:
 * `FileNotFoundError: File not found: /workspace/broken.mjs`. A CREATE through
 * the mount demanded the file already exist: the write path reads first to
 * tell create from overwrite, the sandbox file view passed the SDK's typed
 * miss through untranslated instead of answering ENOENT, and the refusal
 * classed it as an I/O failure. The same program's `sandbox.writeFile(
 * 'broken.mjs', …)` — the codemode namespace, no read-first — wrote fine, and
 * its `sandbox.listFiles('')` came back a `ValidationFailedError` because the
 * SDK refuses the empty path the namespace passed straight through.
 *
 * WHY EVERY GATE STAYED GREEN. The conformance double answered a missing read
 * with an exit code — the SDK's OLD contract — while the deployed SDK throws
 * `FileNotFoundError`; the exit-code path still worked, so nothing upstream
 * ever met a typed miss. And `listFiles` was only ever called with real paths.
 *
 * THE ASSERTIONS, all hard: the file tool's write to a path it just listed as
 * absent answers `created`, a read returns the bytes byte-for-byte, and a
 * `sandbox.listFiles('')` inside one program names the file — not a refusal.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { firstRunSpliceStep, firstRunTurnEvents } from './turn-settlement';
import type { RunEvent } from '../../packages/core/src/index';

const SUITE = 'First-run · sandbox-mount-write';

const CASE = 'sandbox-mount-write' as const;

/** The mounted path the defect named, and the bytes this case chose. */
const TARGET = '/sandbox/workspace/first-run-mount.mjs';

const BYTES = 'export const firstRun = "KINU_SANDBOX_MOUNT_OK";\n';

/** The turn's marker, so its own events can be picked out of the workspace's
 *  log — the genesis turn's events are not this case's evidence. */
const MARK = 'MOUNT-WRITE-PROBE';

/** One turn that does the whole defect: the listing, the create, the read-back
 *  and the empty-path namespace listing — the same calls the failed run made. */
const ASK = `This turn is identified by ${MARK}. Do all of this, in order, without ` +
  'narrating:\n' +
  `1. With the file tool, list ${TARGET.slice(0, TARGET.lastIndexOf('/'))} — it should be empty.\n` +
  `2. With the file tool, write ${TARGET} containing exactly these bytes:\n${BYTES}` +
  '3. With the file tool, read that path back.\n' +
  `4. With eval, run: const ls = await sandbox.listFiles(''); return ls;\n` +
  'Then answer with one line naming the file you wrote.';

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const isToolCallEnd = (event: RunEvent): event is ToolCallEnd => event.type === 'tool_call_end';

/** The args a `file` call carried — the surface the write is addressed through. */
const FileArgsSchema = v.looseObject({ action: v.optional(v.string()), path: v.optional(v.string()) });

function fileCall(calls: readonly ToolCallEnd[], action: string, path: string): ToolCallEnd | undefined {
  return calls.find((call) => {
    if (call.name !== 'file') return false;
    const args = v.safeParse(FileArgsSchema, call.args);

    return args.success && args.output.action === action && args.output.path === path;
  });
}

const answered = (call: ToolCallEnd): boolean =>
  call.error === undefined && call.outcome?.success !== false;

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      purpose: 'A terse assistant that carries out file instructions verbatim.',
      async run({ session }) {
        const landing = await session.prompt(ASK);

        // The ask may have spliced into genesis: the calls that answer it are
        // the absorbing run's, from the step the splice landed in onward.
        const calls = firstRunTurnEvents(await session.runEvents(), ASK, {
          splicedAtStep: firstRunSpliceStep(await session.history(), ASK),
          absorbedBy: landing.landed === 'mid-turn' ? landing.absorbedBy : undefined,
        }).filter(isToolCallEnd);

        // The create itself, read straight off the tool-call ledger: the
        // mount's write path is what the defect refused.
        const write = fileCall(calls, 'write', TARGET);

        const created = write !== undefined && answered(write)
          && v.is(v.looseObject({ action: v.literal('created') }), write.result);

        // The read-back: bytes through the same mount, off the tool result.
        const read = fileCall(calls, 'read', TARGET);

        const readBack = read !== undefined && answered(read)
          && v.is(v.string(), read.result) && read.result.includes(BYTES.trim());

        // The namespace listing of the working directory through an EMPTY
        // path — the second half of the defect — inside an eval call.
        const program = calls.find((call) =>
          call.name === 'eval' && answered(call)
          && JSON.stringify(call.args ?? {}).includes("listFiles('')")
          && JSON.stringify(call.result ?? '').includes('first-run-mount.mjs'));

        return [
          {
            what: 'write-created',
            reached: created,
            detail: write === undefined
              ? `no answered file write to ${TARGET} in this turn`
              : `file write ${TARGET} answered ${JSON.stringify(write.result ?? write.error)}`,
          },
          {
            what: 'read-back',
            reached: readBack,
            detail: read === undefined
              ? `no file read of ${TARGET} answered`
              : `file read returned ${JSON.stringify(read.result ?? read.error)}`,
          },
          {
            what: 'empty-path-listing',
            reached: program !== undefined,
            detail: program === undefined
              ? 'no eval call ran sandbox.listFiles(\'\') and returned the file\'s name'
              : `sandbox.listFiles('') inside eval named the written file`,
          },
        ] satisfies EvalSubgoal[];
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
