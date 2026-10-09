/**
 * A hosted turn cut off inside a claimed call: the next activation resumes the turn, the call's effect is not made
 * again, and the model is told the call may have taken effect (item 6; DESIGN reds 1 and 3 on the hosted path). The
 * claimed call is an `eval` that adds a task and then never returns, so its effect lands and the call stays open when
 * the activation dies.
 */
import { expect, setSystemTime, test } from 'bun:test';
import { AwaitedList } from '@kinu.run/test-utils';
import {
  GATEWAY_CATALOG, driveUntil, gatewayWorkspace, reactivateOrchestratorHarness, rosterOver, wakeForDelegatedTask,
} from './helpers/actor-harness';
import { abandonHarnessFibers, joinHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const BRIEF = 'Find someone to check the release notes.';

/** Longer than any backoff a cut earns, which the shared one caps at a minute. */
const RESTART_AFTER_MS = 120_000;

/** The effect, then a wait the dying activation never sees end: a hold the harness can name. */
const CODE = "await tools.tasks({ op: 'add', titles: ['check the release notes'] }); "
  + "await globalThis[Symbol.for('kinu.test.hold')]('the claimed eval, cut off');";

test('a hosted turn cut off inside a claimed call makes it once and is told it may have taken effect', async () => {
  const parked = new AwaitedList<true>();
  let cut = true;
  const resumed: string[] = [];

  const gateway = stubAiBinding((run) => {
    if (!openingOf(run).includes(BRIEF)) return chatCompletion(run, 'ok');

    if (!cut) {
      resumed.push(JSON.stringify(requestOf(run).messages));

      return chatCompletion(run, 'handled');
    }

    parked.push(true);

    return toolCallCompletion(run, { tool: 'eval', args: { code: CODE } }, 'eval_0');
  });

  const first = gatewayWorkspace(gateway);

  const child = await first.agent.actorDirectory({
    action: 'register', creationId: 'lead', name: 'lead', origin: 'agent', lifetime: 'durable',
  });

  rosterOver(first.db).create({
    name: 'lead', actorReference: child.reference, birth: null, deleteRequested: false,
    status: 'working', currentTask: BRIEF, createdAt: Date.now(), dismissedAt: null, taskEventId: null,
  });

  const tasks = () => first.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM agent_tasks WHERE actor_id = ?')
    .get(child.reference.actorId)?.n ?? 0;

  await wakeForDelegatedTask(first, child.reference.actorId, BRIEF);
  await parked.until((seen) => seen.length === 1);

  await driveUntil(first, 'the claimed eval never wrote its task', () => tasks() > 0);

  abandonHarnessFibers();
  cut = false;
  // Past the backoff a cut in the step's own work earns (D12), so the next activation asks again at once.
  setSystemTime(new Date(Date.now() + RESTART_AFTER_MS));

  try {
    const next = await reactivateOrchestratorHarness(first.db, undefined, {
      world: { aiGateway: gateway },
      beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
    });

    await next.agent.accountSpend();
    await next.agent.terminalRetryPass();
    await joinHarnessFibers();
    await driveUntil(next, 'the resumed turn never asked the model again', () => resumed.length > 0);
  } finally {
    setSystemTime();
  }

  expect(tasks()).toBe(1);
  expect(resumed.join('\n')).toMatch(/may or may not have taken effect\..*the call is eval_0/su);
});
