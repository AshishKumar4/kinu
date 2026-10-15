/**
 * FIRST RUN: a long command on the owner's machine shows its output in the workspace while it runs.
 *
 * THE ASK (2026-10-02). A command on the owner's machine that outlasts its call's foreground window detaches into a
 * job, and the job's output must reach the workspace's rooms as the machine prints it: every line, in order, and all
 * of it before a reader of the job's row can see it settled. Before the device leg streamed, the machine sent nothing
 * until the command ended, so a build that ran for minutes looked stuck the whole time.
 *
 * WHY NO OTHER ROW GUARDS THIS. machine-consent and two-machines run `hostname`, which answers inside the window, so
 * no device job ever forms; the device suites drive the daemon, the hub and the tunnel in-process.
 *
 * ONE SOCKET FOR ORDER. The frames, the `reads_changed` that moves the jobs read, and the read's own answers all
 * travel on the case's one socket, where arrival order is the room's send order. A read over the session's own
 * socket would race this one, and "before the settle" would mean nothing.
 *
 * CONSENT FIRST. The machine is granted `always` before the ask, as two-machines and approve-clears grant it: a call
 * the owner's answer lets through is re-issued in the turn that answer wakes, and a woken turn's foreground window
 * outlasts the command, so no job would form. The ask runs it in a chat turn of its own, once that wake has ended.
 *
 * NO CLOCK. The wake is awaited on its own end, the turn on its own done frame, and the job's settle on the
 * workspace's own `reads_changed`.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { scratchDir, workerSession, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import { JOB_OUTPUT_EVENT, JobOutputFrameSchema, ORCHESTRATOR_AGENT_SLUG, READS_CHANGED_EVENT } from '../../packages/core/src/index';
import { consentWakeEnded, grantDeviceConsent, type DeviceAccount } from './device-session';
import { attachMachine, detachMachine, type AttachedMachine } from './daemon';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { openPublicSocket, type HeardBroadcast, type PublicSocket } from './public-socket';
import { DEVICE_JOB_ASK as ASK, DEVICE_JOB_COMMAND, DEVICE_JOB_TICKS } from './asks';

const SUITE = 'First-run · device-job-output';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: '2026-10-02: a command on the owner\'s machine that outlasted its call\'s foreground window became a job '
    + 'whose output reached the workspace only as its settled result, so a build that ran for minutes showed nothing.',
  missedBecause: 'machine-consent and two-machines run `hostname`, which answers inside the window, so no device '
    + 'job ever formed; the device suites drive the daemon, the hub and the tunnel in-process against doubles.',
  provedRedAt: null,
  redDirection: 'Run on a loopback `vite dev` build of this tree with the daemon from 0be36f6fa^, before the device '
    + 'leg streamed: the job reads completed with all 45 ticks in its result, but no job_output frame arrives, so '
    + '`frames-in-order`, `every-tick-heard` and `heard-before-settle` are missed; the current daemon reaches all five '
    + 'with 15 frames.',
};

const MACHINE = 'kinu-first-run-devjob';

/** The jobs read the Work tab lists from, and the one its `reads_changed` names. */
const JOBS_READ = 'listBackgroundJobs';

const PLAN = firstRunCasePlan(SUITE, 'devjob');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const JobRowsSchema = v.array(v.object({ id: v.string(), label: v.optional(v.nullable(v.string())), status: v.string() }));

/** The lines the command prints, in order. */
const TICKS = Array.from({ length: DEVICE_JOB_TICKS }, (_, at) => `tick ${String(at + 1)}`);

interface JobOutputHeard {
  readonly at: number;
  readonly seq: number;
  readonly lines: readonly string[];
}

/** The job's frames among `heard`, each with its place in the socket's order. */
function framesOf(heard: readonly HeardBroadcast[], jobId: string): JobOutputHeard[] {
  return heard.flatMap((broadcast, at) => {
    if (broadcast.type !== JOB_OUTPUT_EVENT) return [];
    const frame = v.safeParse(JobOutputFrameSchema, broadcast.frame);

    if (!frame.success || frame.output.jobId !== jobId) return [];
    const text = frame.output.chunks.map((chunk) => chunk.text).join('');

    return [{ at, seq: frame.output.seq, lines: text.split('\n').filter((line) => line !== '') }];
  });
}

/**
 * The device job's row once a read over `socket` finds it settled, and how many broadcasts that socket had heard
 * before the answer: the read is re-taken at each `reads_changed` naming the jobs read, armed before the read so a
 * move during it is not lost. Null when the socket or the budget ends first.
 */
async function settledJob(socket: PublicSocket): Promise<{ id: string; status: string; heardBefore: number } | null> {
  for (;;) {
    const moved = socket.broadcast(READS_CHANGED_EVENT);
    const rows = v.parse(JobRowsSchema, await socket.rpc(JOBS_READ, [50]));
    // Taken as the answer's continuation runs: the socket has appended exactly what arrived before it.
    const heardBefore = socket.heard().length;
    const job = rows.find((row) => (row.label ?? '').includes(DEVICE_JOB_COMMAND));

    if (job !== undefined && job.status !== 'running' && job.status !== 'queued') return { id: job.id, status: job.status, heardBefore };

    if (!(await moved)) return null;
  }
}

/** Where the job's frames fell against the first answer reading it settled, for the record. */
function settleDetail(settled: { readonly id: string; readonly heardBefore: number }, heard: number, late: readonly JobOutputHeard[]): string {
  if (heard === 0) return `no frame arrived before the first answer reading ${settled.id} settled`;

  if (late.length === 0) return `every frame arrived before the first answer reading ${settled.id} settled (broadcast ${String(settled.heardBefore)})`;

  return `${String(late.length)} frame(s) arrived after the job read settled, from seq ${String(late[0]?.seq)}`;
}

/** What this case connected and must put away. */
interface CaseState {
  machine: AttachedMachine | null;
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    const account: DeviceAccount = { origin: PLAN.origin, cliToken: workerSession(PLAN.llm).token, identity: PLAN.identity };
    const held: CaseState = { machine: null };

    try {
      await runFirstRunCase(PLAN, {
        id: CASE,
        defect: DEFECT,
        modelCalls: 'expected',
        budgetMs: 5 * 60_000,
        genesis: false,
        purpose: 'An assistant that runs long commands on the owner\'s own machine when asked to.',
        async run({ session, plan, budget }) {
          const subgoals: EvalSubgoal[] = [];
          const socket = openPublicSocket(plan.origin, plan.identity, `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`, budget);

          try {
            if (!(await socket.opened)) {
              subgoals.push({ what: 'job-detached', reached: false, detail: `${socket.path} refused the upgrade` });

              return subgoals;
            }

            const machine = await attachMachine({ account, name: MACHINE, home: scratchDir('first-run-devjob') });
            held.machine = machine;

            const closed = socket.turnClosed();
            await grantDeviceConsent(account, machine.deviceId, session.workspace);

            if (!(await consentWakeEnded(session, socket, closed))) {
              subgoals.push({ what: 'job-detached', reached: false, detail: 'the socket or the budget ended before the run the grant woke ended' });

              return subgoals;
            }

            await session.prompt(ASK);
            const settled = await settledJob(socket);

            subgoals.push({
              what: 'job-detached',
              reached: settled !== null,
              detail: settled === null
                ? 'the socket or the budget ended before a job running the command read settled'
                : `${settled.id} ran the command and read ${settled.status}`,
            });

            if (settled === null) return subgoals;
            const frames = framesOf(socket.heard(), settled.id);
            const seqs = frames.map((frame) => frame.seq);
            // More than one frame: output that streams, not one dump at the end.
            const inOrder = frames.length > 1 && seqs.every((seq, at) => seq === at + 1);

            subgoals.push({
              what: 'frames-in-order',
              reached: inOrder,
              detail: `${String(frames.length)} job_output frame(s), seq ${seqs.join(',') || 'none'}`,
            });

            const lines = frames.flatMap((frame) => frame.lines);

            subgoals.push({
              what: 'every-tick-heard',
              reached: lines.length === TICKS.length && lines.every((line, at) => line === TICKS[at]),
              detail: `${String(lines.length)} of ${String(TICKS.length)} lines heard: ${lines.slice(0, 2).join(', ')}${lines.length > 2 ? ` … ${lines.at(-1) ?? ''}` : ''}`,
            });

            const late = frames.filter((frame) => frame.at >= settled.heardBefore);

            subgoals.push({
              what: 'heard-before-settle',
              reached: frames.length > 0 && late.length === 0,
              detail: settleDetail(settled, frames.length, late),
            });

            return subgoals;
          } finally {
            socket.close('the row is done');
          }
        },
      }, observations);
    } finally {
      if (held.machine !== null) {
        const left = await detachMachine(account, held.machine);

        if (left !== null) console.warn(`    [first-run] ${CASE} teardown: ${left}`);
      }
    }
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
