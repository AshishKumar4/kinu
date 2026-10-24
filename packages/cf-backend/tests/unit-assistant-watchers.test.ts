/**
 * The Personal assistant's GitHub and Gmail checks are watchers (owner, 2026-10-23: its schedules should be "push
 * based/event driven", their checks code against its connections, and a model only "if anything has changed"). Before,
 * each was a model turn every 15 minutes, whether anything was new or not. A check reads its connection at no model
 * call and wakes the assistant only with what is new, once, on the workspace's fast model. Through a real
 * OrchestratorAgent seeded from the real blueprint, its checks run as production runs them (the in-process Worker
 * Loader) over recorded GitHub and Gmail answers.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { blueprintSeed, kinuBlueprint, type GitHubAnswer, type GitHubRead, type GoogleAnswer, type GoogleCall, type JsonValue } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import { fireSoonestWake, orchestratorHarness, until, type RecordedUserPlaneCalls, type StartedHarness } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { answeringGateway, GATEWAY_MODEL, openingOf, type StubbedAiBinding } from './helpers/platform-gateway';

const FAST_MODEL = 'ai-gateway/workers-ai/@cf/harness/fast';

afterEach(() => { setSystemTime(); });

/** The installed assistant, its blueprint's `labels` armed, its model answering `Noted.` to everything. */
async function assistant(labels: readonly string[], plane: Pick<RecordedUserPlaneCalls, 'github' | 'google' | 'profile'>) {
  setSystemTime(new Date('2026-10-24T09:00:00.000Z'));
  const gateway = answeringGateway('Noted.');
  const workspace = orchestratorHarness({ warmConnections: [], failWarm: null, titles: [], ...plane }, { aiGateway: gateway, googleClient: true });

  workspace.agent.harnessInstallCatalog({
    tiers: { default: { model: GATEWAY_MODEL }, deep: { model: GATEWAY_MODEL }, fast: { model: FAST_MODEL } }, availableModels: [GATEWAY_MODEL, FAST_MODEL],
  });
  await workspace.started;
  const { seed } = blueprintSeed(present(kinuBlueprint('personal-assistant'), 'the Personal assistant'), { owner: 'Ashish', connected: ['github', 'google'], timeZone: 'UTC' });

  await workspace.agent.seedBlueprint({ ...seed, schedules: seed.schedules.filter(({ label }) => labels.includes(label)) });

  return { gateway, workspace };
}

/** The workspace's wakes, each to its end, to the next one that checked (`checked` grew). */
async function nextCheck(workspace: StartedHarness, checked: () => number): Promise<void> {
  const before = checked();

  for (let wakes = 0; checked() === before; wakes += 1) {
    if (wakes === 10) throw new Error('ten wakes and no check');
    await fireSoonestWake(workspace.agent, workspace.db);
    await joinHarnessFibers();
  }
}

/** The model requests a check's turn made: those opened by `asked`. */
const turnsOn = (gateway: StubbedAiBinding, asked: string) => gateway.runs.filter((run) => openingOf(run).includes(asked));

const ModelSchema = v.object({ model: v.string() });

describe("the assistant's GitHub check", () => {
  test('reads GitHub at no model call while nothing new needs the owner, then wakes once for a review asked of them, on the fast model', async () => {
    let modified = 'Fri, 24 Oct 2026 09:00:00 GMT';
    let inbox: JsonValue[] = [];
    const reads: GitHubRead[] = [];

    // GitHub as it answers /notifications: unchanged since `If-Modified-Since`, a 304; `since` read inclusively here,
    // so the newest one seen comes back and is not news twice.
    const answer = (read: GitHubRead): GitHubAnswer => {
      if (read.ifModifiedSince === modified) return { status: 304, body: null, headers: { lastModified: modified } };
      const since = read.query?.['since'];

      return { status: 200, body: inbox.filter((item) => since === undefined || String(v.parse(v.object({ updated_at: v.string() }), item).updated_at) >= String(since)), headers: { lastModified: modified } };
    };

    const { gateway, workspace } = await assistant(['GitHub check'], { github: { reads, answer } });
    const checked = () => reads.length;

    // The first check marks where to start; the next five find nothing changed.
    for (let check = 0; check < 6; check += 1) await nextCheck(workspace, checked);
    expect({ checks: reads.length, modelCalls: gateway.runs.length, paths: [...new Set(reads.map(({ path }) => path))] })
      .toEqual({ checks: 6, modelCalls: 0, paths: ['/notifications'] });

    const at = new Date().toISOString();

    const notification = (id: string, reason: string) => ({
      id, reason, updated_at: at, unread: true, repository: { full_name: 'kinu/ledger' },
      subject: { title: `Ledger ${id}`, url: `https://api.github.com/repos/kinu/ledger/pulls/${id}`, type: 'PullRequest' },
    });

    inbox = [notification('7', 'review_requested'), notification('8', 'subscribed')];
    modified = 'Fri, 24 Oct 2026 10:40:00 GMT';
    await nextCheck(workspace, checked);
    await until(() => turnsOn(gateway, 'New GitHub notifications').length > 0, 'the check never woke the assistant');

    const woke = turnsOn(gateway, 'New GitHub notifications for Ashish');

    expect(woke.length).toBe(1);
    expect(openingOf(present(woke[0], 'the woken turn'))).toContain('review requested: kinu/ledger "Ledger 7" https://github.com/kinu/ledger/pull/7');
    expect(openingOf(present(woke[0], 'the woken turn'))).not.toContain('Ledger 8');
    expect(FAST_MODEL.endsWith(v.parse(ModelSchema, present(woke[0], 'the woken turn').query).model)).toBe(true);

    // Unchanged, then changed with nothing new in it: neither wakes it again.
    const calls = gateway.runs.length;

    await nextCheck(workspace, checked);
    modified = 'Fri, 24 Oct 2026 10:50:00 GMT';
    await nextCheck(workspace, checked);
    expect({ turns: turnsOn(gateway, 'New GitHub notifications').length, modelCalls: gateway.runs.length - calls }).toEqual({ turns: 1, modelCalls: 0 });
  });
});

describe("the assistant's Gmail check", () => {
  test("reads Gmail's history at no model call while the inbox is unchanged, then wakes once for new inbox mail", async () => {
    // Gmail's history: each record a message added, with its labels; a history id is the newest record's.
    const records: { readonly id: number; readonly message: string; readonly labels: readonly string[] }[] = [];
    let historyId = 100;
    // Gmail keeps history for a while only: a start before this is a 404.
    let kept = 0;
    const calls: GoogleCall[] = [];
    const ok = (body: JsonValue): GoogleAnswer => ({ status: 200, body, headers: {} });

    const answer = (call: GoogleCall): GoogleAnswer => {
      const url = new URL(call.url);

      if (url.pathname.endsWith('/profile')) return ok({ emailAddress: 'ashish@example.com', historyId: String(historyId) });

      if (url.pathname.endsWith('/history')) {
        const from = Number(url.searchParams.get('startHistoryId'));

        if (from < kept) return { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.' } }, headers: {} };
        const history = records.filter(({ id }) => id > from).map(({ id, message, labels }) => ({ id: String(id), messagesAdded: [{ message: { id: message, labelIds: [...labels] } }] }));

        return ok({ historyId: String(historyId), ...(history.length > 0 && { history }) });
      }

      const id = url.pathname.split('/').at(-1);

      return ok({ id: id ?? '', payload: { headers: [{ name: 'From', value: 'Ana <ana@example.com>' }, { name: 'Subject', value: `Invoice ${id ?? ''}` }] } });
    };

    const { gateway, workspace } = await assistant(['Gmail check'], { google: { calls, answer } });
    const checked = () => calls.filter((call) => call.url.endsWith('/profile') || call.url.includes('/history')).length;

    for (let check = 0; check < 6; check += 1) await nextCheck(workspace, checked);
    expect(gateway.runs.length).toBe(0);

    // One letter to the inbox, and one the owner sent: only the letter is news.
    historyId = 102;
    records.push({ id: 101, message: 'm1', labels: ['INBOX', 'UNREAD'] }, { id: 102, message: 'm2', labels: ['SENT'] });
    await nextCheck(workspace, checked);
    await until(() => turnsOn(gateway, 'New mail in').length > 0, 'the check never woke the assistant');

    const woke = turnsOn(gateway, "New mail in Ashish's inbox");

    expect(woke.length).toBe(1);
    expect(openingOf(present(woke[0], 'the woken turn'))).toContain('1 new in the inbox:\\nAna <ana@example.com>: "Invoice m1" (m1)');
    expect(FAST_MODEL.endsWith(v.parse(ModelSchema, present(woke[0], 'the woken turn').query).model)).toBe(true);

    const after = gateway.runs.length;

    for (let check = 0; check < 3; check += 1) await nextCheck(workspace, checked);
    expect({ turns: turnsOn(gateway, 'New mail in').length, modelCalls: gateway.runs.length - after }).toEqual({ turns: 1, modelCalls: 0 });

    // A history id Gmail no longer keeps starts again from now: nothing before it is news, and nothing wakes.
    historyId = 300;
    kept = 200;
    records.push({ id: 250, message: 'm3', labels: ['INBOX'] });
    await nextCheck(workspace, checked);
    await nextCheck(workspace, checked);
    expect({ turns: turnsOn(gateway, 'New mail in').length, last: calls.at(-1)?.url }).toEqual({ turns: 1, last: expect.stringContaining('startHistoryId=300') });
  });
});

// Installed at version 1, an assistant's GitHub and Gmail checks were plain schedules, a model turn every 15 minutes
// each. Its blueprint's version 2 replaces just those two, in place, before either fires again; the daily brief, the
// soul and the layout stay as installed (docs/HOME-EXPLORE.md §11).
test("an assistant installed at version 1 has its GitHub and Gmail checks replaced by version 2's watchers, and nothing else", async () => {
  setSystemTime(new Date('2026-10-24T09:00:00.000Z'));
  const reads: GitHubRead[] = [];
  const gateway = answeringGateway('Noted.');

  const workspace = orchestratorHarness(
    { warmConnections: [], failWarm: null, titles: [], profile: { email: 'ashish@example.com' }, github: { reads, answer: () => ({ status: 200, body: [], headers: {} }) } },
    { aiGateway: gateway, googleClient: true },
  );

  await workspace.started;
  await workspace.agent.seedBlueprint({
    blueprint: 'personal-assistant', layout: 'focus', agent: 'Kinu', connected: ['github'],
    schedules: [
      { label: 'Daily brief', cron: '0 8 * * *', timeZone: 'UTC', prompt: "Write Ashish's brief for today." },
      { label: 'GitHub check', cron: '*/15 * * * *', connection: 'github', prompt: 'Check GitHub with your GitHub tools for what is new since your last check.' },
      { label: 'Gmail check', cron: '*/15 * * * *', connection: 'google', prompt: "Check Ashish's Gmail through google.* for mail since your last check." },
    ],
  });

  const triggers = async () => new Map((await workspace.agent.listTriggers()).triggers.filter(({ state }) => state === 'active')
    .map((trigger) => [v.parse(v.object({ label: v.string() }), trigger.spec).label, trigger] as const));

  const before = await triggers();

  await nextCheck(workspace, () => reads.length);
  const after = await triggers();
  const github = present(after.get('GitHub check'), 'the GitHub check');

  // In place: the same trigger, its schedule kept, its check and tier the blueprint's; read by its program, no turn.
  expect({ id: github.id, cron: github.spec['cron'], tier: github.spec['tier'], reads: reads.length, modelCalls: gateway.runs.length })
    .toEqual({ id: present(before.get('GitHub check'), 'the v1 GitHub check').id, cron: '*/15 * * * *', tier: 'fast', reads: 1, modelCalls: 0 });
  expect(github.spec['check']).toEqual(present(kinuBlueprint('personal-assistant'), 'the blueprint').automations.find(({ label }) => label === 'GitHub check')?.check);
  expect(github.spec['payload']).toEqual({ prompt: expect.stringContaining('New GitHub notifications for ashish') });
  expect(after.get('Daily brief')).toEqual(before.get('Daily brief'));

  // Gmail's, kept unarmed while Google is not held, is armed as version 2's once it is.
  await workspace.agent.connectionsChanged(['github', 'google']);
  expect(present((await triggers()).get('Gmail check'), 'the Gmail check').spec['check']).toMatchObject({ reads: ['google'] });
});
