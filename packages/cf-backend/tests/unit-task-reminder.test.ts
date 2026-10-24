/**
 * An agent that stops with tasks open is reminded of them by a turn of its own. Its `tasks` tool runs in the workspace
 * and writes the workspace's store, while its chat decides the reminder in its own isolate (D9): the chat reads the open
 * tasks where the tool wrote them.
 */
import { expect, test } from 'bun:test';
import type { OwnerAnswer } from '@kinu.run/core';
import { setDiagnosticsSink } from '@kinu.run/core/obs';
import { createRecordingLogger, present } from '@kinu.run/test-utils';
import { wrapDatabase } from '@kinu.run/core/identity';
import { actorConnectionTag } from '@kinu.run/core';
import { asPane, joinHarnessFibers } from './helpers/agents-sdk';
import { agentSql, agentWakes, catalogTurn, driveUntil, gatewayWorkspace, jobsOver, until, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

/** A main agent that adds one task, starts on it and stops; every request it is sent, kept. */
function openTaskWorkspace() {
  const asked: string[] = [];

  const gateway = stubAiBinding((run) => {
    const { messages } = requestOf(run);
    const sent = JSON.stringify(messages);

    asked.push(sent);

    if (sent.includes('open task(s)')) return chatCompletion(run, 'Back on it.');

    return messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Started on the migration.')
      : toolCallCompletion(run, { tool: 'tasks', args: { op: 'add', titles: ['Migrate the ledger to integer cents'] } }, 'add_0');
  });

  return { asked, workspace: gatewayWorkspace(gateway) };
}

test('a root turn that stops with its tasks open is reminded of them', async () => {
  const { asked, workspace } = openTaskWorkspace();

  await catalogTurn(workspace.agent, 'Plan the ledger migration and start on it.');
  await driveUntil(workspace, 'the open task was never reminded', () => asked.some((sent) => sent.includes('open task(s)')));

  expect(asked.find((sent) => sent.includes('open task(s)'))).toContain('Migrate the ledger to integer cents');
});

const ASK = {
  questions: [{
    id: 'units', question: 'Which unit should the ledger store?', header: 'Units', recommended: 0,
    options: [{ label: 'Integer cents', description: 'Exact.' }, { label: 'Decimal dollars', description: 'Readable.' }],
  }],
};

const ANSWER: OwnerAnswer[] = [{ id: 'units', selected: ['Integer cents'] }];

// A turn that ended on a question to its owner with a task open queued its reminder behind the question, and the agent
// still read as owing a turn: each wake, about a minute apart, re-ran the reminder's effect, found its turn still queued,
// and armed the next, for as long as the question stood. Held behind the question, the reminder is parked: nothing wakes
// for it until the owner answers or withdraws the question, even when the isolate that queued it ended meanwhile.
for (const closing of ['answers', 'withdraws', 'withdraws after the isolate ended'] as const) {
  test(`a reminder that waits behind an open question arms no wake, and runs once the owner ${closing}`, async () => {
    const asked: string[] = [];

    const gateway = stubAiBinding((run) => {
      const { messages } = requestOf(run);
      const sent = JSON.stringify(messages);
      const results = messages.filter((message) => message.role === 'tool').length;

      asked.push(sent);

      if (sent.includes('open task(s)')) return chatCompletion(run, 'Back on it.');

      if (results === 0) return toolCallCompletion(run, { tool: 'tasks', args: { op: 'add', titles: ['Migrate the ledger to integer cents'] } }, 'add_0');

      return results === 1 ? toolCallCompletion(run, { tool: 'ask_owner', args: ASK }, 'call_ask') : chatCompletion(run, 'Storing integer cents.');
    });

    const workspace = gatewayWorkspace(gateway);
    const main = workspaceMainActor(workspace.db).actorId;
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    try {
      await catalogTurn(workspace.agent, 'Plan the ledger migration and start on it.');
      await workspace.agent.terminalRetryPass();
    } finally {
      restore();
    }

    const [question] = (await workspace.agent.listOwnerQuestions()).filter((asking) => asking.asked.status === 'open');
    const parked = log.emitted.filter((line) => line.event === 'turn.terminal_effect_parked').map((line) => line.fields.waits);

    expect({ open: question !== undefined, wakes: agentWakes(workspace.db).filter((actor) => actor === main), reminded: asked.some((sent) => sent.includes('open task(s)')), parked })
      .toEqual({ open: true, wakes: [], reminded: false, parked: ['owner_question'] });

    if (closing === 'withdraws after the isolate ended') workspace.agent.harnessResetAgentIsolate(workspace.agent.agentOf(main).storageKey);

    if (closing === 'answers') await workspace.agent.answerOwnerQuestions(question?.asked.id ?? '', ANSWER);
    else await workspace.agent.dismissOwnerQuestions(question?.asked.id ?? '');

    await driveUntil(workspace, `the reminder never ran once the owner ${closing}`, () => asked.some((sent) => sent.includes('open task(s)')));
  });
}

// Parked is no wake, and still work its agent holds: a Stop of the agent that hired it reaches it, with its isolate alive
// or ended since, and dismisses the question the queue waited behind.
for (const isolate of ['alive', 'ended'] as const) {
  test(`a hired agent's reminder parked behind its question is stopped by its hirer's Stop, its isolate ${isolate}`, async () => {
    let asking = false;

    const gateway = stubAiBinding((run) => {
      const { messages } = requestOf(run);
      const sent = JSON.stringify(messages);
      const results = messages.filter((message) => message.role === 'tool').length;

      if (sent.includes('Plan the ledger migration')) {
        if (results === 0) return toolCallCompletion(run, { tool: 'tasks', args: { op: 'add', titles: ['Migrate the ledger to integer cents'] } }, 'add_0');

        asking ||= results === 1;

        return results === 1 ? toolCallCompletion(run, { tool: 'ask_owner', args: ASK }, 'call_ask') : chatCompletion(run, 'Storing integer cents.');
      }

      if (sent.includes('Keep the ledger.') || results > 0) return chatCompletion(run, 'Ready.');

      return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'durable', message: 'Keep the ledger.' } }, 'call_hire');
    });

    const workspace = gatewayWorkspace(gateway);

    await catalogTurn(workspace.agent, 'Hire a ledger keeper.');
    const hired = workspace.db.query<{ id: string }, []>("SELECT actor_id AS id FROM workspace_actors WHERE origin = 'agent'").get()?.id ?? '';

    await workspace.agent.harnessAgentsIdle();
    await asPane([actorConnectionTag(hired)], () => workspace.agent.send('Plan the ledger migration and start on it.', crypto.randomUUID()));
    await driveUntil(workspace, 'the hired agent never asked', () => asking);
    await workspace.agent.harnessAgentsIdle();
    await workspace.agent.terminalRetryPass();
    const status = async () => (await workspace.agent.listOwnerQuestions()).filter((question) => question.actor === hired).map((question) => question.asked.status);

    expect({ open: await status(), wakes: agentWakes(workspace.db).filter((actorId) => actorId === hired) }).toEqual({ open: ['open'], wakes: [] });

    if (isolate === 'ended') workspace.agent.harnessResetAgentIsolate(workspace.agent.agentOf(hired).storageKey);

    await workspace.agent.cancelCurrentWork();
    // The Stop reaches the agents below on a task of its own, and closes the question in the agent's own store.
    await driveUntil(workspace, "the Stop never dismissed the hired agent's question", () => agentSql(workspace, hired)<{ status: string }>`
      SELECT status FROM owner_questions WHERE actor_id = ${hired}`.every((question) => question.status === 'dismissed'));

    expect(await status()).toEqual(['dismissed']);
  });
}

/** Requests whose newest message is a task reminder: one per reminder the agent was sent. */
const reminders = (asked: readonly string[]) => asked.filter((sent) => sent.lastIndexOf('open task(s)') > sent.lastIndexOf('"role":"assistant"')).length;

// An agent that hired help and ended its turn on a task the hire works on is parked on a result owed to it: reminding
// it raced the hire's report, every time the hire spoke (hearthlit-field-04d5879b, 10-24: five reminders in eleven
// minutes). It is reminded once the report lands and the task is still open, once for that list however many turns end
// on it, and once more when the list moves.
test('an agent waiting on its hire is not reminded until the report lands, then once per state of its list', async () => {
  const asked: string[] = [];
  const working = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let atReport = -1;
  let exportAdded = false;

  const gateway = stubAiBinding(async (run) => {
    const { messages } = requestOf(run);
    const sent = JSON.stringify(messages);
    const results = messages.filter((message) => message.role === 'tool').length;

    // The hire's own run, opened by its assignment; main's requests name the assignment too, in the hire's call.
    if (openingOf(run).includes('Tally the ledger.')) {
      started.resolve();
      await working.promise;

      return chatCompletion(run, 'The ledger tallies to 412 rows.');
    }

    asked.push(sent);

    if (!openingOf(run).includes('Plan the ledger migration')) return chatCompletion(run, 'Noted.');

    if (sent.includes('412 rows') && atReport < 0) atReport = asked.length - 1;

    // The owner's later words: one leaves the list as it was, one adds to it, once (the call's id is not the model's).
    if (sent.includes('Also export the ledger.') && !exportAdded) {
      exportAdded = true;

      return toolCallCompletion(run, { tool: 'tasks', args: { op: 'add', titles: ['Export the ledger'] } }, 'add_export');
    }

    if (results === 0) return toolCallCompletion(run, { tool: 'tasks', args: { op: 'add', titles: ['Migrate the ledger to integer cents'] } }, 'add_0');

    if (results === 1) return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', message: 'Tally the ledger.' } }, 'hire_0');

    return chatCompletion(run, 'Waiting on the tally.');
  });

  const workspace = gatewayWorkspace(gateway);
  const main = workspaceMainActor(workspace.db).actorId;

  await workspace.agent.send('Plan the ledger migration and start on it.', crypto.randomUUID(), []);
  await started.promise;
  // Main's turn ended, its hire still working: whatever it owed has had its laps to run.
  await until(() => agentSql(workspace, main)<{ x: number }>`SELECT 1 AS x FROM run_events WHERE type = 'run_end'`.length > 0, "main's turn never ended");
  await workspace.agent.terminalRetryPass();
  await joinHarnessFibers();

  expect(reminders(asked)).toBe(0);

  working.resolve();
  await driveUntil(workspace, 'the open task was never reminded after the report', () => reminders(asked) > 0);
  await workspace.agent.terminalRetryPass();

  // The report reached main before its reminder did.
  expect({ reportFirst: atReport >= 0 && atReport < asked.findIndex((sent) => reminders([sent]) > 0), reminders: reminders(asked) })
    .toEqual({ reportFirst: true, reminders: 1 });

  // Another turn ends on the same list: owed nothing again, though the owner spoke.
  await workspace.agent.send('Any news?', crypto.randomUUID(), []);
  await until(() => asked.some((sent) => sent.includes('Any news?')), 'the owner was never heard');
  await workspace.agent.terminalRetryPass();
  await joinHarnessFibers();
  expect(reminders(asked)).toBe(1);

  // A task added is a new list: reminded once more.
  await workspace.agent.send('Also export the ledger.', crypto.randomUUID(), []);
  await driveUntil(workspace, 'the moved list was never reminded', () => reminders(asked) > 1);
  expect(reminders(asked)).toBe(2);
});

const BUILD_JOB = 'bgjob-release-build';

/**
 * Main adds a task and hires an agent for it; the hire starts a job of its own on the assignment (a row its runner would
 * write) and ends its turn saying so. Woken by the job's end, it answers. Main's requests, and the hire's, kept.
 */
function hireWithJobWorkspace(lifetime: 'durable' | 'task') {
  const asked: string[] = [];
  const hireStarted = Promise.withResolvers<void>();
  const jobStarted = Promise.withResolvers<void>();

  const gateway = stubAiBinding(async (run) => {
    const { messages } = requestOf(run);
    const sent = JSON.stringify(messages);
    const results = messages.filter((message) => message.role === 'tool').length;

    if (openingOf(run).includes('Build the release.')) {
      hireStarted.resolve();
      await jobStarted.promise;

      return chatCompletion(run, 'Started the release build; I will report when it finishes.');
    }

    // The hire, woken by its job's end.
    if (openingOf(run).includes(BUILD_JOB)) return chatCompletion(run, 'The release build stopped before it finished.');

    asked.push(sent);

    if (!openingOf(run).includes('Ship the release')) return chatCompletion(run, 'Noted.');

    if (results === 0) return toolCallCompletion(run, { tool: 'tasks', args: { op: 'add', titles: ['Ship the release'] } }, 'add_0');

    if (results === 1) return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime, message: 'Build the release.' } }, 'hire_0');

    return chatCompletion(run, 'Waiting on the build.');
  });

  const workspace = gatewayWorkspace(gateway);
  const main = workspaceMainActor(workspace.db).actorId;

  return {
    asked, workspace,
    /** The owner asks; the hire starts its job and ends its turn; every turn that owed main something has run. */
    hireRunsItsJob: async () => {
      await workspace.agent.send('Ship the release.', crypto.randomUUID(), []);
      await hireStarted.promise;

      const [hire] = wrapDatabase(workspace.db).sql<{ actorId: string; name: string }>`
        SELECT actor_id AS actorId, name FROM workspace_actors WHERE parent_actor_id = ${main}`;

      const hired = present(hire, 'the hired agent');

      jobsOver(workspace.db, hired.actorId).create({ id: BUILD_JOB, kind: 'shell', workMode: 'build', label: 'bun run build:release', now: Date.now() });
      jobStarted.resolve();
      await until(() => agentSql(workspace, hired.actorId)<{ x: number }>`SELECT 1 AS x FROM run_events WHERE type = 'run_end'`.length > 0, "the hire's turn never ended");
      await workspace.agent.terminalRetryPass();
      await joinHarnessFibers();

      return hired;
    },
  };
}

// The owner, 2026-10-24: "what about if the agent has a subagent that has a background job and isn't technically
// waiting on it, and thus isn't working but still the main agent shouldnt be reminded right?" A hire that ended its turn
// on a job of its own is still working for its hirer: its answer comes when the job ends.
test("an agent whose hire ended its turn on a job of its own is not reminded until that work ends", async () => {
  const { asked, workspace, hireRunsItsJob } = hireWithJobWorkspace('durable');
  const hired = await hireRunsItsJob();

  // The hire's turn-end words reached main, which ended its own turn on them: no reminder while the job runs.
  expect(asked.some((sent) => sent.includes('Started the release build'))).toBe(true);
  expect(reminders(asked)).toBe(0);

  // The job ends (the owner's cancel); the hire, woken, says so; then the open task is reminded, once.
  expect(await workspace.agent.cancelBackgroundJob(BUILD_JOB, hired.name)).toEqual({ ok: true });
  await driveUntil(workspace, 'the open task was never reminded after the hire answered', () => reminders(asked) > 0);
  await workspace.agent.terminalRetryPass();

  expect({
    answeredFirst: asked.findIndex((sent) => sent.includes('stopped before it finished')) < asked.findIndex((sent) => reminders([sent]) > 0),
    reminders: reminders(asked),
  }).toEqual({ answeredFirst: true, reminders: 1 });
});

// A task hire's reply is its one answer: one sent while a job of its own runs on the question was its last word on it,
// and the job's result never reached the agent that asked.
test("a task hire's words while a job of its own runs are not its answer; its answer comes when the job ends", async () => {
  const { asked, workspace, hireRunsItsJob } = hireWithJobWorkspace('task');
  const hired = await hireRunsItsJob();

  expect({ interim: asked.some((sent) => sent.includes('Started the release build')), reminders: reminders(asked) })
    .toEqual({ interim: false, reminders: 0 });

  expect(await workspace.agent.cancelBackgroundJob(BUILD_JOB, hired.name)).toEqual({ ok: true });
  await driveUntil(workspace, "the hire's answer never reached main", () => asked.some((sent) => sent.includes('stopped before it finished')));
  await driveUntil(workspace, 'the open task was never reminded after the answer', () => reminders(asked) > 0);

  expect({ interim: asked.some((sent) => sent.includes('Started the release build')), reminders: reminders(asked) })
    .toEqual({ interim: false, reminders: 1 });
});

// A process started to keep running owes the agent nothing: a preview server beside an open task, unrelated to it,
// must not silence the reminder however long it runs.
test('a long-running preview server does not hold the reminder of an unrelated open task', async () => {
  const { asked, workspace } = openTaskWorkspace();
  const jobs = jobsOver(workspace.db);
  const runningAtReminder: string[][] = [];

  // Its agent started first: a job its start finds running is one an earlier activation lost, which it ends.
  await catalogTurn(workspace.agent, 'Note the preview port.');
  jobs.create({ id: 'bgjob-preview', kind: 'startProcess', workMode: 'build', now: Date.now(), label: 'preview: bun run dev' });

  await catalogTurn(workspace.agent, 'Plan the ledger migration and start on it.');
  await driveUntil(workspace, 'the open task was never reminded beside the preview server', () => {
    if (reminders(asked) === 0) return false;
    runningAtReminder.push(jobs.listRunning().items.map((job) => job.id));

    return true;
  });

  expect(runningAtReminder).toEqual([['bgjob-preview']]);
});
