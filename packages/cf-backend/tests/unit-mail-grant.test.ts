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
import { driveUntil, gatewayWorkspace, jobsOver } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, stubAiBinding, type RecordedGatewayRun } from './helpers/platform-gateway';

const DOMAIN = 'kinu.example';

/** The owner's Mailbox object, over a real store holding no address until `open`. */
function ownerMailbox() {
  const sql = makeSqlExec(new Database(':memory:'));

  initMailboxTables(sql);

  const store = new MailStore({
    sql, domain: DOMAIN, now: () => Date.now(), id: () => crypto.randomUUID(), parse: parseMail,
    blobs: { put: () => Promise.resolve(), text: () => Promise.resolve(null), delete: () => Promise.resolve() },
    digest: (bytes) => Promise.resolve(createHash('sha256').update(bytes).digest('hex')),
  });

  return {
    open: () => { store.open({ userId: 'u-owner', email: 'owner@example.com', username: 'owner', assistant: null }); },
    object: {
      boxes: () => Promise.resolve(store.boxes()),
      readableBy: (caller: Parameters<MailStore['readableBy']>[0]) => Promise.resolve(store.readableBy(caller)),
      findFor: (caller: Parameters<MailStore['findFor']>[0], query: Parameters<MailStore['findFor']>[1]) => Promise.resolve(store.findFor(caller, query)),
    },
  };
}

const OfferedSchema = v.looseObject({
  messages: v.optional(v.array(v.unknown())),
  tools: v.optional(v.array(v.looseObject({ function: v.looseObject({ name: v.string(), description: v.optional(v.string()) }) }))),
});

/** Whether the tool-bearing request that carried `words` offered `mail` in its eval program surface; null if none did. */
function mailOffered(runs: readonly RecordedGatewayRun[], words: string): boolean | null {
  const asked = runs.find((run) => {
    const request = v.parse(OfferedSchema, run.query);

    return (request.tools ?? []).length > 0 && JSON.stringify(request.messages ?? []).includes(words);
  });

  if (asked === undefined) return null;
  const program = (v.parse(OfferedSchema, asked.query).tools ?? []).find((tool) => tool.function.name === 'eval')?.function.description ?? '';

  return /^- mail:/mu.test(program);
}

// Each turn reads it as it opens: an owner who makes an address is offered mail at the next turn, with nothing kept.
test("a turn offers mail only while its owner holds an address, read as each turn opens", async () => {
  const gateway = stubAiBinding((run) => chatCompletion(run, 'Hello.'));
  const mailbox = ownerMailbox();
  const workspace = gatewayWorkspace(gateway, { mailbox: { domain: DOMAIN, owner: mailbox.object } });

  const turn = async (words: string) => {
    await workspace.agent.send(words, crypto.randomUUID());
    await driveUntil(workspace, `the turn "${words}" never asked the model`, () => mailOffered(gateway.runs, words) !== null);

    return mailOffered(gateway.runs, words);
  };

  const before = await turn('Before any address: what can you do?');

  mailbox.open();

  expect({ before, after: await turn('With an address: what can you do?') }).toEqual({ before: false, after: true });
});

// The same gap on a run seat (rc30 follow-up): a head or swarm node is seated with its own sources and builds its own
// eval, and read no mail plane, so its programs held `mail` on an account with none. It reads the turn's plane as it
// is seated. Driven as a swarm job its activation re-drives, whose seats ask the model with their own eval.
test("a swarm's seats are offered mail only while the owner holds an address", async () => {
  const task = 'Name one way to tokenize faster.';
  const offered: Record<string, boolean | null> = {};

  for (const [account, opened] of [['with an address', true], ['with none', false]] as const) {
    const mailbox = ownerMailbox();

    if (opened) mailbox.open();
    const gateway = stubAiBinding((run) => chatCompletion(run, 'Use a trie.'));
    const workspace = gatewayWorkspace(gateway, { mailbox: { domain: DOMAIN, owner: mailbox.object } });

    // Started by a dead activation: this one's first pass re-drives it.
    jobsOver(workspace.db).create({
      id: 'bgjob-search', kind: 'agents', workMode: 'build', now: Date.now() - 60_000, label: 'search: tokenize faster',
      input: JSON.stringify({ op: 'swarm', task, preset: 'ideate', branches: 1, depth: 1 }),
    });

    try {
      await workspace.agent.activateActor();
      await driveUntil(workspace, 'no seat of the swarm asked the model', () => mailOffered(gateway.runs, task) !== null);
      offered[account] = mailOffered(gateway.runs, task);
    } finally {
      await workspace.agent.cancelBackgroundJob('bgjob-search');
      await joinHarnessFibers();
    }
  }

  expect(offered).toEqual({ 'with an address': true, 'with none': false });
});
