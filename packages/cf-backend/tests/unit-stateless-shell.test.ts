/**
 * The workspace shell, as the agent's shell tool reaches it: every call is a fresh shell starting at its `cwd` or the
 * agent's home, side by side with any other; a `name` keeps its directory and exported variables, one call at a time.
 * Staging, 2026-10-02 (PassiveGull, live sandbox hang): the agent's one durable shell queued an `echo` 6,032 s behind
 * a `find`, and a `cd` from one call steered every later one. Fresh and named shells are the workerd slate-durability
 * journey's; a long command held open, on the job clock this harness moves, is this file's.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { WORKSPACE_ROOT, type JsonObject } from '@kinu.run/core';
import { handClock } from '@kinu.run/test-utils';
import { catalogTurn, gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const UserTextSchema = v.union([v.string(), v.pipe(v.array(v.looseObject({ text: v.string() })), v.transform((parts) => parts.map((part) => part.text).join('')))]);

/** The owner's latest words, and the tool answers the model has read since. */
function sinceAsked(run: RecordedGatewayRun) {
  const { messages } = requestOf(run);
  const at = messages.reduce((latest, message, index) => (message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context') ? index : latest), -1);
  const asked = at === -1 ? '' : v.parse(UserTextSchema, messages[at]?.content);

  return { asked, answers: messages.slice(at + 1).filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content)) };
}

/** A model that, asked one of `scripts`' names, makes its shell calls in order, then answers. */
function shellModel(scripts: Readonly<Record<string, readonly JsonObject[]>>) {
  return stubAiBinding((run) => {
    const { asked, answers } = sinceAsked(run);
    const script = scripts[asked] ?? [];
    const next = script[answers.length];

    return next === undefined ? chatCompletion(run, 'Done.') : toolCallCompletion(run, { tool: 'shell', args: next }, `call_${String(answers.length)}`);
  });
}

/** What each shell call of the turn that `asked` answered, in order, as the model read it. */
function answered(gateway: ReturnType<typeof shellModel>, asked: string): readonly string[] {
  const last = gateway.runs.filter((run) => sinceAsked(run).asked === asked).at(-1);

  return last === undefined ? [] : sinceAsked(last).answers.map((answer) => v.parse(v.string(), JSON.parse(answer)));
}

/** A process `ps` lists as still running; an entry's command can span lines, each entry opening on its pid. */
const runningLine = (ps: string, command: string): boolean => ps.split(/\n(?=\s+\d+\s)/).some((entry) => entry.includes(command) && entry.includes('running'));

test('a long command held open holds up no other call, its name answers busy, and a cancel stops it', async () => {
  const clock = handClock(Date.now());

  const gateway = shellModel({
    serve: [{ command: 'sleep 600', name: 'server' }],
    check: [{ command: 'echo independent' }, { command: 'echo again', name: 'server' }, { command: 'ps' }],
    after: [{ command: 'ps', name: 'server' }],
  });

  const workspace = gatewayWorkspace(gateway, { jobClock: clock });

  // The long call's window is the job clock's first wait; it passes, and the call goes on as a job.
  const serving = catalogTurn(workspace.agent, 'serve');
  await clock.whenArmed(1);
  clock.tick();
  await serving;
  const [job] = await workspace.agent.listBackgroundJobs();

  expect(job).toMatchObject({ kind: 'shell', status: 'running' });
  const jobId = job?.id ?? '';

  // An unrelated call finishes while the long one runs; its name answers at once; `ps` still lists it.
  await catalogTurn(workspace.agent, 'check');
  const [independent, busy, running] = answered(gateway, 'check');

  expect(independent).toBe(`cwd: ${WORKSPACE_ROOT}\nindependent\n`);
  expect(busy).toContain(`shell server is busy with job ${jobId} since `);
  expect(runningLine(running ?? '', 'sleep 600')).toBe(true);

  expect(await workspace.agent.cancelBackgroundJob(jobId)).toEqual({ ok: true });
  expect((await workspace.agent.listBackgroundJobs()).find((listed) => listed.id === jobId)?.status).toBe('cancelled');

  // The name is free again; its next call starts once the stopped command has ended, and nothing of it still runs.
  await catalogTurn(workspace.agent, 'after');
  const [after] = answered(gateway, 'after');

  expect(after).toContain('sleep 600');
  expect(runningLine(after ?? '', 'sleep 600')).toBe(false);
});
