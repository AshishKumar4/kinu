// Mail in and mail out, as the Worker takes it: raw MIME at the `email()` entry, the workspace's receipt, the turn it
// opens, and that turn's answer threaded back to the sender; a refused send retried by the next wake; a redelivery
// answered once; and an entry that cannot reach the workspace failing by name without its cause's secrets.
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { KinuError, createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { handleInboundEmail } from '../src/email/handler';
import { fireSoonestWake, orchestratorHarness, until, type RecordedUserPlaneCalls } from './helpers/actor-harness';
import { refuseUnlistedHeaders } from './helpers/email-service';

afterEach(() => { setSystemTime(); });

const DOMAIN = 'agents.example.com';

const SentSchema = v.object({
  from: v.union([v.string(), v.object({ email: v.string(), name: v.string() })]),
  to: v.union([v.string(), v.array(v.string())]),
  subject: v.string(),
  text: v.optional(v.string()),
  headers: v.optional(v.record(v.string(), v.string())),
});

type Sent = v.InferOutput<typeof SentSchema>;

/** One message as the platform hands the Worker's `email()` entry: envelope, headers and the raw MIME stream. */
function inbound(to: string, mime: { subject: string; messageId: string; inReplyTo?: string; references?: string; body: string }) {
  const raw = [
    'From: owner@example.com', `To: ${to}`, `Subject: ${mime.subject}`, `Message-ID: ${mime.messageId}`,
    ...(mime.inReplyTo === undefined ? [] : [`In-Reply-To: ${mime.inReplyTo}`]),
    ...(mime.references === undefined ? [] : [`References: ${mime.references}`]),
    'Content-Type: text/plain', '', mime.body,
  ].join('\r\n');

  return Object.assign(Object.create(null), {
    from: 'owner@example.com', to, rawSize: raw.length,
    headers: new Headers({ 'message-id': mime.messageId }),
    raw: new Response(raw).body,
  });
}

test('an email opens a turn whose answer threads back to the sender; a refused send is retried, a redelivery answered once', async () => {
  const sent: Sent[] = [];
  let refusing = false;

  const userPlane: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [], profile: { email: 'owner@example.com' } };

  /** The `send_email` binding: each message it is handed, read at that boundary. */
  async function send(message: EmailMessage): Promise<EmailSendResult>;
  async function send(message: Parameters<SendEmail['send']>[0]): Promise<EmailSendResult>;
  async function send(message: EmailMessage | Parameters<SendEmail['send']>[0]): Promise<EmailSendResult> {
    if (refusing) throw new Error('E_SENDER_NOT_VERIFIED');
    const parsed = v.parse(SentSchema, message);

    refuseUnlistedHeaders(parsed.headers);
    sent.push(parsed);

    return { messageId: `<out-${String(sent.length)}@${DOMAIN}>` };
  }

  const { agent, db } = orchestratorHarness(userPlane, { email: { send } });

  agent.harnessHoldsCapability('harness-token');
  agent.modelFactory = () => scriptedTurnModel({ doGenerate: () => ({
    content: [{ type: 'text', text: 'Yes — staging is green.' }], finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
    warnings: [],
  }) });

  const address = `${agent.name}@${DOMAIN}`;
  const env = Object.assign(Object.create(null), { EMAIL_DOMAIN: DOMAIN, OrchestratorAgent: { idFromName: (name: string) => name, get: () => agent } });
  const replies = () => sent.filter((mail) => mail.headers?.['Auto-Submitted'] === 'auto-replied' && mail.text === 'Yes — staging is green.');

  const deliver = async (mime: Parameters<typeof inbound>[1]) => {
    await handleInboundEmail(inbound(address, mime), env);
    await fireSoonestWake(agent, db);
  };

  const first = { subject: 'Check the deploy', messageId: '<abc@mail.example.com>', references: '<root@mail.example.com>', body: 'Is staging green?' };

  await deliver(first);
  await until(() => replies().length === 1, 'the first answer was sent');

  const [receipt] = sent;
  const [reply] = replies();

  // A refused send keeps the channel open; the next wake sends the answer, once.
  refusing = true;
  await deliver({ subject: 'Re: Check the deploy', messageId: '<def@mail.example.com>', inReplyTo: '<abc@mail.example.com>', body: 'and production?' });
  refusing = false;

  // The outbox's retry rides the soonest wakes; nothing is resent by hand.
  for (let wakes = 0; wakes < 6 && replies().length < 2; wakes++) {
    await fireSoonestWake(agent, db);
    await until(() => true, 'a lap');
  }

  await until(() => replies().length === 2, 'the refused answer was sent by a later wake');

  // The platform delivers the first message again: no second receipt, no second turn.
  const before = sent.length;

  await handleInboundEmail(inbound(address, first), env);

  expect({
    receipt: {
      subject: receipt?.subject, inReplyTo: receipt?.headers?.['In-Reply-To'], references: receipt?.headers?.References,
      // RFC 3834: without it a peer agent's inbox would answer, looping two agents.
      autoSubmitted: receipt?.headers?.['Auto-Submitted'], says: receipt?.text?.includes('has your message'),
    },
    reply: { to: reply?.to, subject: reply?.subject, inReplyTo: reply?.headers?.['In-Reply-To'], references: reply?.headers?.References },
    retried: { subject: replies()[1]?.subject, inReplyTo: replies()[1]?.headers?.['In-Reply-To'] },
    redelivered: sent.length - before,
  }).toEqual({
    receipt: {
      subject: 'Re: Check the deploy', inReplyTo: '<abc@mail.example.com>', references: '<root@mail.example.com> <abc@mail.example.com>',
      autoSubmitted: 'auto-replied', says: true,
    },
    reply: { to: 'owner@example.com', subject: 'Re: Check the deploy', inReplyTo: '<abc@mail.example.com>', references: '<root@mail.example.com> <abc@mail.example.com>' },
    // An existing `Re:` is not prefixed again.
    retried: { subject: 'Re: Check the deploy', inReplyTo: '<def@mail.example.com>' },
    redelivered: 0,
  });
});

test('an email the workspace cannot take fails as a classified error, logged by name, with no secret of its cause', async () => {
  const logs = createRecordingLogger();
  const restore = setDiagnosticsSink(logs);

  const env = Object.assign(Object.create(null), {
    EMAIL_DOMAIN: DOMAIN,
    OrchestratorAgent: {
      idFromName: () => { throw new Error('object storage unreachable at node sk-live-SECRET'); },
      get: () => { throw new Error('unreachable'); },
    },
  });

  const failed = handleInboundEmail(inbound(`atlas@${DOMAIN}`, { subject: 'hi', messageId: '<x@mail.example.com>', body: 'hi' }), env);

  await expect(failed).rejects.toBeInstanceOf(KinuError);
  await expect(failed).rejects.not.toThrow(/sk-live-SECRET/);
  restore();
  expect(logs.emitted.filter((line) => line.event === 'email.delivery_failed').map((line) => line.code)).toEqual(['io']);
});
