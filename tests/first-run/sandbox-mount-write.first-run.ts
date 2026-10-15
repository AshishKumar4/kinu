/**
 * FIRST RUN: a file written through the `/computer` mount is a file in the
 * container's working directory, and an empty path lists it.
 *
 * THE DEFECT. In the trajectory run public-failure-recovery (kinu.run at
 * 96c3fa2b0, run-6k2kglxfvqag1l0hwg8o8, 2026-09-14) the agent listed
 * `/computer/workspace` — empty — then asked the file tool to write
 * `/computer/workspace/broken.mjs` and was refused `io`:
 * `FileNotFoundError: File not found: /workspace/broken.mjs`. A CREATE through
 * the mount demanded the file already exist: the write path reads first to
 * tell create from overwrite, the sandbox file view passed the SDK's typed
 * miss through untranslated instead of answering ENOENT, and the refusal
 * classed it as an I/O failure. The same program's `computer.writeFile(
 * 'broken.mjs', …)` — the codemode namespace, no read-first — wrote fine, and
 * its `computer.listFiles('')` came back a `ValidationFailedError` because the
 * SDK refuses the empty path the namespace passed straight through.
 *
 * WHY EVERY GATE STAYED GREEN. The conformance double answered a missing read
 * with an exit code — the SDK's OLD contract — while the deployed SDK throws
 * `FileNotFoundError`; the exit-code path still worked, so nothing upstream
 * ever met a typed miss. And `listFiles` was only ever called with real paths.
 *
 * THE ASSERTIONS, all hard: the file tool's write to a path it just listed as
 * absent answers `created`, a read returns the bytes byte-for-byte, and a
 * `computer.readdir({ path: '' })` inside one program names the file — not a refusal. The historical
 * `listFiles` name above is gone; the native platform listing remains an internal transport method.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { firstRunSpliceStep, firstRunTurnEvents } from './turn-settlement';
import { MOUNT_ASK as ASK, MOUNT_BYTES as BYTES, MOUNT_TARGET as TARGET } from './asks';
import type { RunEvent } from '../../packages/core/src/index';

const SUITE = 'First-run · sandbox-mount-write';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'Writing a new file through the /computer mount was refused `io` — '
    + '"FileNotFoundError: File not found: /workspace/broken.mjs" — while the same '
    + 'container write through computer.writeFile in a program succeeded, and '
    + 'computer.listFiles(\'\') refused on the SDK\'s ValidationFailedError.',
  missedBecause: 'the conformance double answered a missing read with an exit code, the SDK\'s '
    + 'old contract; the deployed SDK throws FileNotFoundError, which the file view passed '
    + 'through unclassified, so the write path\'s create-vs-overwrite probe read a create as an '
    + 'I/O failure. No test ever called listFiles with an empty path.',
  provedRedAt: '96c3fa2b0',
  redDirection: 'retained run bench-artifacts/trajectory-product-1789381033344/'
    + 'public-failure-recovery/events.jsonl on 2026-09-14: event 9 is the refused create '
    + '(reason io, FileNotFoundError on a path the list at event 7 showed absent), event 12 is '
    + 'the namespace write succeeding where the mount write failed and listFiles(\'\') refusing '
    + 'on ValidationFailedError.',
};

const PLAN = firstRunCasePlan(SUITE, 'mount');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const isToolCallEnd = (event: RunEvent): event is ToolCallEnd => event.type === 'tool_call_end';

/** The args a `file` call carried — the surface the write is addressed through. */
const FileArgsSchema = v.looseObject({ op: v.optional(v.string()), path: v.optional(v.string()) });

function fileCall(calls: readonly ToolCallEnd[], op: string, path: string): ToolCallEnd | undefined {
  return calls.find((call) => {
    if (call.name !== 'file') return false;
    const args = v.safeParse(FileArgsSchema, call.args);

    return args.success && args.output.op === op && args.output.path === path;
  });
}

const answered = (call: ToolCallEnd): boolean =>
  call.error === undefined && call.outcome?.success !== false;

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      defect: DEFECT,
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
          && JSON.stringify(call.args ?? {}).includes("computer.readdir({ path: '' })")
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
              ? 'no eval call ran computer.readdir({ path: \'\' }) and returned the file\'s name'
              : `computer.readdir({ path: '' }) inside eval named the written file`,
          },
        ] satisfies EvalSubgoal[];
      },
    }, observations);
  });
});
