/**
 * rc29 production walkthrough (F7): on an account with no mail address and no way to make one, the assistant's Home
 * introduction offered to read its mail. Its agents held `mail` whenever the deployment had a mail domain; they hold it
 * now only while the owner holds an address, read once per turn from the owner's Mailbox without making a box.
 */
import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { initMailboxTables, MailStore } from '@kinu.run/core';
import { makeSqlExec } from '../../core/tests/helpers';
import { parseMail } from '../src/mail/parse';
import { driveUntil, gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding, type RecordedGatewayRun } from './helpers/platform-gateway';

const DOMAIN = 'kinu.example';

/** The owner's Mailbox object, over a real store: opened, the owner holds an address. */
function ownerMailbox(opened: boolean) {
  const sql = makeSqlExec(new Database(':memory:'));

  initMailboxTables(sql);

  const store = new MailStore({
    sql, domain: DOMAIN, now: () => Date.now(), id: () => crypto.randomUUID(), parse: parseMail,
    blobs: { put: () => Promise.resolve(), text: () => Promise.resolve(null), delete: () => Promise.resolve() },
    digest: (bytes) => Promise.resolve(createHash('sha256').update(bytes).digest('hex')),
  });

  if (opened) store.open({ userId: 'u-owner', email: 'owner@example.com', username: 'owner', assistant: null });

  return {
    boxes: () => Promise.resolve(store.boxes()),
    readableBy: (caller: Parameters<MailStore['readableBy']>[0]) => Promise.resolve(store.readableBy(caller)),
    findFor: (caller: Parameters<MailStore['findFor']>[0], query: Parameters<MailStore['findFor']>[1]) => Promise.resolve(store.findFor(caller, query)),
  };
}

const OfferedSchema = v.looseObject({ tools: v.optional(v.array(v.looseObject({ function: v.looseObject({ name: v.string(), description: v.optional(v.string()) }) }))) });

/** Whether the turn's request offered `mail` in its eval program surface. */
function mailOffered(run: RecordedGatewayRun): boolean {
  const program = (v.parse(OfferedSchema, run.query).tools ?? []).find((tool) => tool.function.name === 'eval')?.function.description ?? '';

  return /^- mail:/mu.test(program);
}

test("a turn's agents are offered mail while the owner holds an address, and none where the owner holds none", async () => {
  const offered: Record<string, boolean | null> = {};

  for (const [account, opened] of [['with an address', true], ['with none', false]] as const) {
    const gateway = stubAiBinding((run) => chatCompletion(run, 'Hello.'));
    const workspace = gatewayWorkspace(gateway, { mailbox: { domain: DOMAIN, owner: ownerMailbox(opened) } });

    await workspace.agent.send('What can you do for me?', crypto.randomUUID());
    await driveUntil(workspace, 'the turn never asked the model', () => gateway.runs.some((run) => (v.parse(OfferedSchema, run.query).tools ?? []).length > 0));

    const asked = gateway.runs.find((run) => (v.parse(OfferedSchema, run.query).tools ?? []).length > 0);

    offered[account] = asked === undefined ? null : mailOffered(asked);
  }

  expect(offered).toEqual({ 'with an address': true, 'with none': false });
});
