/**
 * Words a person types while the agent's step runs a long tool call move that call to the background at once, as its
 * foreground window would: the same job and the same handle, told why. The words then land at the step its handle
 * ends, so the model reads the handle and the words in one request and answers at once; nothing waits as queued. The
 * job's end wakes the agent later, as any job's does.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { handClock } from '@kinu.run/test-utils';
import { catalogTurn, driveUntil, gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';
import { serverBox, SERVES_MS } from './helpers/server-box';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

/** What a call moved to the background because the person wrote is told (core `jobs/threshold.ts`). */
const RELEASED_FOR_PERSON = 'The person wrote while this ran; backgrounded: still running, not cancelled.';

const ASK = 'Start the server and keep it running.';

const WORDS = 'While that runs, what port will it serve on?';

const SteerFrameSchema = v.object({ type: v.literal('steer_status'), status: v.string(), steerId: v.string() });

interface SaidPart {
  readonly role: 'tool' | 'user';
  readonly text: string;
}

/** What a request read back from its tool calls, and what the person said in it, in order. */
function turnOf(run: RecordedGatewayRun): SaidPart[] {
  return requestOf(run).messages.flatMap((message): SaidPart[] => {
    const text = JSON.stringify(message.content);

    if (message.role === 'tool') return [{ role: 'tool', text }];

    return message.role === 'user' && !text.includes('<dynamic_context') ? [{ role: 'user', text }] : [];
  });
}

test("words typed while a long command runs move it to a job, and reach the model beside its handle, never queued", async () => {
  const clock = handClock(Date.now());

  const gateway = stubAiBinding((run) => {
    const said = turnOf(run);

    if (said.some((part) => part.text.includes(WORDS))) return chatCompletion(run, 'It serves on :3000, and it is still running.');


    return said.at(-1)?.text.includes(ASK) === true
      ? toolCallCompletion(run, { tool: 'shell', args: { command: 'node server.js', runtime: 'computer' } }, 'call_server')
      : chatCompletion(run, 'Noted.');
  });

  const box = serverBox(clock);
  const workspace = gatewayWorkspace(gateway, { container: true, box: () => box, jobClock: clock, previewHostSuffix: 'preview.test' });
  const frames: string[] = [];

  // The owner's egress vault is read before a sandbox command runs.
  workspace.agent.harnessDeclareEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  await catalogTurn(workspace.agent, 'Start the ledger.');
  Reflect.set(workspace.agent, 'broadcast', (payload: string) => { frames.push(payload); });

  // The command serves, its window and its life armed on the clock, which never moves until the words are answered.
  const turn = catalogTurn(workspace.agent, ASK);

  await box.served(1);
  await workspace.agent.send(WORDS, 'words-mid-call');
  await turn;

  const answered = gateway.runs.find((run) => turnOf(run).some((part) => part.text.includes(WORDS)));
  const said = answered === undefined ? [] : turnOf(answered);
  const handle = said.findIndex((part) => part.role === 'tool' && part.text.includes(RELEASED_FOR_PERSON));

  expect(handle).toBeGreaterThanOrEqual(0);
  expect(said.slice(handle + 1).some((part) => part.role === 'user' && part.text.includes(WORDS))).toBe(true);

  const statuses = frames.flatMap((frame) => {
    const parsed = v.safeParse(SteerFrameSchema, JSON.parse(frame));

    return parsed.success && parsed.output.steerId === 'words-mid-call' ? [parsed.output.status] : [];
  });

  expect(statuses).toEqual(['landed']);
  // It listens on its port, so the job reads as serving.
  const [job] = await workspace.agent.listBackgroundJobs(20);

  expect(job).toMatchObject({ kind: 'shell', status: 'serving' });
  const jobId = job?.id ?? '';

  expect(said[handle]?.text).toContain(jobId);

  // Its life ends; its end wakes the agent, as any job's does.
  clock.advance(SERVES_MS);
  await driveUntil(workspace, "the job's end never woke the agent", () => gateway.runs.some((run) => turnOf(run).at(-1)?.text.includes(jobId) === true));
  expect((await workspace.agent.listBackgroundJobs(20)).map((listed) => listed.status)).toEqual(['completed']);
});
