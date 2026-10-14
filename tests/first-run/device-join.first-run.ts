/**
 * FIRST RUN: the connect command a workspace's Environment hands out joins the machine that runs it, with no sign-in.
 *
 * THE DEFECT. The owner, signed in to the browser that issued it, ran Environment → Connect device's command on a
 * machine. It installed, then printed "Not signed in. Starting Kinu sign-in…" and waited on a device-code page
 * (kinu.run/cli/auth?code=…): the command carried the device it named and no authority, so the machine needed a
 * session of its own. And the device it registered was rooted at /tmp, the directory the command ran in.
 *
 * WHY NO OTHER ROW GUARDS THIS. device-link and the fleet rows register machines through the CLI's own
 * `POST /api/cli/devices` with a bearer the tier already holds, so none of them ran the command a person is given.
 *
 * THE CASE runs the issued command as it is, in a fresh home on this host, from a directory that is not that home,
 * under a terminal (the command asks before it links). The machine must join without a sign-in, read connected on
 * the account, be granted the workspace whose Environment issued it, and be rooted at its home.
 *
 * NO CLOCK. The command's own words end each wait: it links and says so, or it asks for a sign-in; the case's budget
 * stops a command that does neither.
 */
import { afterAll, describe, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { infraBoundary, killAndAwaitExit, recordedIn, scratchDir, workerSession, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import { webHeaders } from '../../evals/src/workspace-roster';
import type { JsonValue } from '../../packages/core/src/index';
import type { DeviceAccount } from './device-session';
import { detachMachine, readDaemonLogTail } from './daemon';
import { FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · device-join';

const CASE = 'device-join' as const;

/** The name the command links this machine under. */
const MACHINE = 'kinu-first-run-join';

/** What the command says once the hub accepted the machine. */
const LINKED = 'Connected as';

/** What the command said instead, on the build the owner ran. */
const SIGN_IN = 'Not signed in';

/** The question the command asks before it links anything. */
const CONFIRM = 'Link and start the daemon?';

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const IssuedSchema = v.object({ installCommand: v.string(), deviceId: v.string() });

const DeviceRowsSchema = v.array(v.looseObject({ id: v.string(), connected: v.boolean() }));

const ConsentRowsSchema = v.array(v.looseObject({ agentName: v.string(), deviceId: v.string(), policy: v.string() }));

const DeviceConfigSchema = v.looseObject({ root: v.string(), device: v.optional(v.string()) });

/** One call of the owner's account routes, as the browser makes it: its status and its body. */
async function userRoute(account: DeviceAccount, path: string, method = 'GET', body?: JsonValue): Promise<{ status: number; body: string }> {
  return infraBoundary(`${method} ${account.origin}/api/user${path}`, async () => {
    const headers = { ...webHeaders(account.identity), 'content-type': 'application/json' };
    const init: RequestInit = body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) };
    const response = await fetch(`${account.origin}/api/user${path}`, init);

    return { status: response.status, body: await response.text() };
  });
}

/** The issued command, run as a person runs it: in `ranIn`, with `home` as the machine's home, under a terminal. */
interface IssuedRun {
  /** Everything the command printed so far, terminal codes stripped. */
  output(): string;
  /** Resolves with the first of `texts` the command prints, or null once it exits or `budget` ends first. */
  saying(texts: readonly string[], budget: AbortSignal): Promise<string | null>;
  answer(line: string): Promise<void>;
  readonly exited: Promise<number>;
  stop(): void;
}

function runIssued(command: string, home: string, ranIn: string): IssuedRun {
  const proc = Bun.spawn({
    cmd: ['script', '-qefc', command, '/dev/null'],
    cwd: ranIn,
    // A person's machine: none of this tier's credentials (its KINU_TOKEN alone signs the CLI in), only what a shell has.
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', LANG: process.env.LANG ?? 'C.UTF-8',
      HOME: home, KINU_HOME: join(home, '.kinu'), KINU_INFLIGHT_ROOT: join(home, '.kinu', 'inflight'),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let printed = '';
  const listeners = new Set<() => void>();
  const decoder = new TextDecoder();

  const reading = (async () => {
    for await (const chunk of proc.stdout) {
      printed += Bun.stripANSI(decoder.decode(chunk, { stream: true }));

      for (const listener of listeners) listener();
    }

    for (const listener of listeners) listener();
  })();

  const ended = Promise.all([reading, proc.exited]);

  return {
    output: () => printed,
    saying: (texts, budget) => new Promise((resolve) => {
      let finished = false;

      const settle = (said: string | null): void => {
        if (finished) return;
        finished = true;
        listeners.delete(check);
        budget.removeEventListener('abort', onBudget);
        resolve(said);
      };

      const check = (): void => {
        const said = texts.find((text) => printed.includes(text));

        if (said !== undefined) settle(said);
      };

      const onBudget = (): void => { settle(null); };

      listeners.add(check);
      budget.addEventListener('abort', onBudget, { once: true });
      ended.then(() => { check(); settle(null); }, () => { settle(null); });
      check();
    }),
    answer: async (line) => {
      await proc.stdin.write(`${line}\n`);
      await proc.stdin.flush();
    },
    exited: proc.exited,
    stop: () => { proc.kill('SIGKILL'); },
  };
}

/** Put the joined machine away: the daemon `kinu connect` started detached, stopped first, then its row revoked. */
async function detachJoined(account: DeviceAccount, deviceId: string, home: string): Promise<string | null> {
  const daemon = recordedIn(join(home, '.kinu', 'pc-agent.pid'));

  if (daemon !== null) await killAndAwaitExit(daemon);

  return await detachMachine(account, { deviceId, name: MACHINE, home, exited: Promise.resolve(0), execLog: () => [], stop: () => {} });
}

/** What this case started and must put away. */
interface CaseState {
  deviceId: string | null;
  run: IssuedRun | null;
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    const account: DeviceAccount = { origin: PLAN.origin, cliToken: workerSession(PLAN.llm).token, identity: PLAN.identity };
    const home = scratchDir('first-run-join');
    const held: CaseState = { deviceId: null, run: null };

    try {
      await runFirstRunCase(PLAN, {
        id: CASE,
        modelCalls: 'none',
        genesis: false,
        purpose: 'A workspace whose owner connects a machine from its Environment.',
        async run({ session, budget }) {
          const subgoals: EvalSubgoal[] = [];
          const issued = await userRoute(account, '/devices', 'POST', { label: MACHINE, workspace: session.workspace });
          const command = issued.status === 201 ? v.safeParse(IssuedSchema, JSON.parse(issued.body)) : null;

          if (command?.success !== true) {
            subgoals.push({ what: 'command-issued', reached: false, detail: `POST /api/user/devices answered ${String(issued.status)}: ${issued.body.slice(0, 300)}` });

            return subgoals;
          }

          const { installCommand, deviceId } = command.output;
          held.deviceId = deviceId;
          // Run from a directory that is not the machine's home, as the owner ran it from /tmp.
          const ranIn = join(home, 'elsewhere');
          mkdirSync(ranIn, { recursive: true });
          const run = runIssued(installCommand, home, ranIn);
          held.run = run;

          const asked = await run.saying([CONFIRM, SIGN_IN], budget);

          if (asked === CONFIRM) await run.answer('y');
          const linked = asked === CONFIRM ? await run.saying([LINKED, SIGN_IN], budget) : asked;

          subgoals.push({
            what: 'command-joins-without-sign-in',
            reached: linked === LINKED && !run.output().includes(SIGN_IN),
            detail: linked === LINKED
              ? `the command linked ${MACHINE} with no sign-in`
              : `the command ${linked === SIGN_IN ? 'asked for a sign-in' : 'neither linked nor asked'}; it printed: ${run.output().slice(-600)}`,
          });

          if (linked !== LINKED) return subgoals;
          await run.exited;

          const devices = await userRoute(account, '/devices');
          const rows = devices.status === 200 ? v.safeParse(DeviceRowsSchema, JSON.parse(devices.body)) : null;
          const row = rows?.success === true ? rows.output.find((device) => device.id === deviceId) : undefined;

          subgoals.push({
            what: 'device-reads-connected',
            reached: row?.connected === true,
            detail: row === undefined
              ? `the devices route answered ${String(devices.status)} without ${deviceId}; the daemon said: ${readDaemonLogTail(join(home, '.kinu', 'pc-agent.log'))}`
              : `${deviceId} reads connected ${String(row.connected)}`,
          });

          const consents = await userRoute(account, '/devices/consents');
          const bound = consents.status === 200 ? v.safeParse(ConsentRowsSchema, JSON.parse(consents.body)) : null;
          const grant = bound?.success === true ? bound.output.find((consent) => consent.deviceId === deviceId) : undefined;

          subgoals.push({
            what: 'issuing-workspace-granted',
            reached: grant?.agentName === session.workspace && grant.policy === 'allow',
            detail: grant === undefined
              ? `no grant for ${deviceId} (consents answered ${String(consents.status)})`
              : `${grant.agentName} holds ${deviceId} as ${grant.policy}`,
          });

          const configPath = join(home, '.kinu', 'device.json');
          const config = existsSync(configPath) ? v.safeParse(DeviceConfigSchema, JSON.parse(readFileSync(configPath, 'utf8'))) : null;

          subgoals.push({
            what: 'rooted-at-home',
            reached: config?.success === true && config.output.root === home && config.output.device === deviceId,
            detail: config?.success === true ? `device.json roots ${config.output.device ?? '?'} at ${config.output.root}; it ran in ${ranIn}` : `no readable ${configPath}`,
          });

          return subgoals;
        },
      }, observations);
    } finally {
      held.run?.stop();

      if (held.deviceId === null) rmSync(home, { recursive: true, force: true });
      else {
        const left = await detachJoined(account, held.deviceId, home);

        if (left !== null) console.warn(`    [first-run] ${CASE} teardown: ${left}`);
      }
    }
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
