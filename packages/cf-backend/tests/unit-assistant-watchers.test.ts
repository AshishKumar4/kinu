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
import { eventsOver, fireSoonestWake, orchestratorHarness, until, type RecordedUserPlaneCalls, type StartedHarness } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { answeringGateway, GATEWAY_MODEL, requestOf, type RecordedGatewayRun, type StubbedAiBinding } from './helpers/platform-gateway';
import { isRuntimeContext, present } from '@kinu.run/test-utils';

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
    // A woken turn arms wakes of its own (its cache's warming, its terminal effects) that come due before the check.
    if (wakes === 40) throw new Error('forty wakes and no check');
    await fireSoonestWake(workspace.agent, workspace.db);
    await joinHarnessFibers();
  }
}

const UserTextSchema = v.union([
  v.string(), v.pipe(v.array(v.looseObject({ text: v.optional(v.string()) })), v.transform((parts) => parts.map((part) => part.text ?? '').join(''))),
]);

/** What a request asked last: its newest user message that is not Kinu's runtime context. */
function askedOf(run: RecordedGatewayRun): string {
  const asked = requestOf(run).messages.filter((message) => message.role === 'user').map((message) => v.parse(UserTextSchema, message.content));

  return asked.filter((text) => !isRuntimeContext(text)).at(-1) ?? '';
}

/** The model requests a check's fire asked: each newest message `asked` (every later turn of the chat opens with it). */
const turnsOn = (gateway: StubbedAiBinding, asked: string) => gateway.runs.filter((run) => askedOf(run).includes(asked));

const ModelSchema = v.object({ model: v.string() });

/** A schedule's fire as the event log keeps it: what its check found. */
const FireSchema = v.looseObject({ watch_brief: v.optional(v.string()) });

/** Each time a check woke the agent, as the workspace's event log keeps it: a turn may ask its model more than once. */
const firesOf = (workspace: StartedHarness) => eventsOver(workspace.db).query({ variant: 'timer' })
  .filter((event) => v.parse(FireSchema, event.payload).watch_brief !== undefined);

/** A seeded schedule's trigger spec, as the owner's trigger list shows it. */
const ScheduleSpecSchema = v.object({ cron: v.string(), tier: v.optional(v.string()), check: v.optional(v.unknown()), payload: v.unknown() });

/** A notification as the fake keeps it; the rest of GitHub's shape is drawn from it. */
interface Notification {
  readonly id: string;
  readonly reason: string;
  readonly updated_at: string;
}

/** The owner's GitHub notifications now, and when they last changed. */
interface GitHubInboxState {
  modified: string;
  inbox: Notification[];
}

/** GitHub as it answers /notifications: a 304 while unchanged since `If-Modified-Since`, else newest first, after
 *  `since` and before `before` (both exclusive, as GitHub reads them), a page of `per_page` at a time. */
function gitHubInbox() {
  const state: GitHubInboxState = { modified: 'Fri, 24 Oct 2026 09:00:00 GMT', inbox: [] };
  const reads: GitHubRead[] = [];

  const answer = (read: GitHubRead): GitHubAnswer => {
    if (read.ifModifiedSince === state.modified) return { status: 304, body: null, headers: { lastModified: state.modified } };
    const { since, before, page = 1, per_page: per = 50 } = v.parse(NotificationsQuerySchema, read.query ?? {});

    const listed = state.inbox.filter(({ updated_at }) => (since === undefined || updated_at > since) && (before === undefined || updated_at < before))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    const body = listed.slice((page - 1) * per, page * per).map((item) => ({
      ...item, unread: true, repository: { full_name: 'kinu/ledger' },
      subject: { title: `Ledger ${item.id}`, url: `https://api.github.com/repos/kinu/ledger/pulls/${item.id}`, type: 'PullRequest' },
    }));

    return { status: 200, body, headers: { lastModified: state.modified } };
  };

  return { state, reads, answer };
}

const NotificationsQuerySchema = v.object({
  since: v.optional(v.string()), before: v.optional(v.string()), page: v.optional(v.number()), per_page: v.optional(v.number()),
});

describe("the assistant's GitHub check", () => {
  test('reads GitHub at no model call while nothing new needs the owner, then wakes once for a review asked of them, on the fast model', async () => {
    const github = gitHubInbox();
    const { gateway, workspace } = await assistant(['GitHub check'], { github });
    const checked = () => github.reads.length;

    // The first check marks where to start; the next five find nothing changed.
    for (let check = 0; check < 6; check += 1) await nextCheck(workspace, checked);
    expect({ checks: github.reads.length, modelCalls: gateway.runs.length, paths: [...new Set(github.reads.map(({ path }) => path))] })
      .toEqual({ checks: 6, modelCalls: 0, paths: ['/notifications'] });

    const at = new Date().toISOString();

    github.state.inbox = [{ id: '7', reason: 'review_requested', updated_at: at }, { id: '8', reason: 'subscribed', updated_at: at }];
    github.state.modified = 'Fri, 24 Oct 2026 10:40:00 GMT';
    await nextCheck(workspace, checked);
    await until(() => turnsOn(gateway, 'New GitHub notifications').length > 0, 'the check never woke the assistant');

    const woke = turnsOn(gateway, 'New GitHub notifications for Ashish');

    expect(firesOf(workspace).length).toBe(1);
    expect(askedOf(present(woke[0], 'the woken turn'))).toContain('review requested: kinu/ledger "Ledger 7" https://github.com/kinu/ledger/pull/7');
    expect(askedOf(present(woke[0], 'the woken turn'))).not.toContain('Ledger 8');
    expect(FAST_MODEL.endsWith(v.parse(ModelSchema, present(woke[0], 'the woken turn').query).model)).toBe(true);

    // Unchanged, then changed with nothing new in it (its read reaches back a second, past the edge): neither wakes it.
    const calls = gateway.runs.length;

    await nextCheck(workspace, checked);
    github.state.modified = 'Fri, 24 Oct 2026 10:50:00 GMT';
    await nextCheck(workspace, checked);
    expect({ fires: firesOf(workspace).length, modelCalls: gateway.runs.length - calls }).toEqual({ fires: 1, modelCalls: 0 });

    // One that came in at the edge, a second before the newest seen, is still news.
    github.state.inbox = [...github.state.inbox, { id: '9', reason: 'mention', updated_at: new Date(Date.parse(at) - 500).toISOString() }];
    github.state.modified = 'Fri, 24 Oct 2026 11:00:00 GMT';
    await nextCheck(workspace, checked);
    await until(() => turnsOn(gateway, 'New GitHub notifications').length > 1, 'the edge notification never woke the assistant');
    expect(askedOf(present(turnsOn(gateway, 'New GitHub notifications').at(-1), 'the edge turn'))).toContain('mentioned: kinu/ledger "Ledger 9"');
  });

  // A check reads ten pages. Past them, it once moved `since` over what it never read, so a burst of more than 500 lost
  // the rest (review, 2026-10-24). Here the oldest one that needs the owner is on the twelfth page.
  test('a burst of more pages than one check reads and more than a brief holds reaches the owner whole, across checks, each once', async () => {
    const github = gitHubInbox();
    const { gateway, workspace } = await assistant(['GitHub check'], { github });
    const checked = () => github.reads.length;

    await nextCheck(workspace, checked);
    const at = Date.now() + 60_000;

    github.state.inbox = Array.from({ length: 600 }, (_, index) => ({
      id: String(100 + index), reason: index % 10 === 0 ? 'review_requested' : 'subscribed', updated_at: new Date(at + index * 1000).toISOString(),
    }));
    github.state.modified = 'Fri, 24 Oct 2026 10:40:00 GMT';
    setSystemTime(new Date(at + 700_000));

    // What the agent was woken with: each fire's brief, as the workspace's event log keeps it.
    const told = () => eventsOver(workspace.db).query({ variant: 'timer' }).map((event) => v.parse(FireSchema, event.payload).watch_brief ?? '').join('\n');
    const needed = github.state.inbox.filter(({ reason }) => reason === 'review_requested').map(({ id }) => id);
    const unsaid = () => needed.filter((id) => !told().includes(`"Ledger ${id}"`));

    // Each check wakes the agent with what one brief holds, until none waits.
    for (let check = 0; check < 30 && unsaid().length > 0; check += 1) await nextCheck(workspace, checked);
    await until(() => turnsOn(gateway, '"Ledger 100"').length > 0, 'the last brief never reached a turn');

    // Every one that needs the owner named in exactly one fire, none read past named, and the oldest reached a turn.
    expect({
      unnamedOrTwice: needed.filter((id) => told().split(`"Ledger ${id}"`).length - 1 !== 1),
      readPast: github.state.inbox.filter(({ reason, id }) => reason === 'subscribed' && told().includes(`"Ledger ${id}"`)).length,
    }).toEqual({ unnamedOrTwice: [], readPast: 0 });
  });
});

describe("the assistant's Gmail check", () => {
  test("reads Gmail's history at no model call while the inbox is unchanged, then wakes once for new inbox mail", async () => {
    // Gmail's history: each record a message added, with its labels; a history id is the newest record's.
    const records: { readonly id: number; readonly message: string; readonly labels: readonly string[] }[] = [];
    let historyId = 100;
    let mailbox = 'ashish@example.com';
    // Gmail keeps history for a while only: a start before this is a 404.
    let kept = 0;
    const calls: GoogleCall[] = [];
    const ok = (body: JsonValue): GoogleAnswer => ({ status: 200, body, headers: {} });

    const answer = (call: GoogleCall): GoogleAnswer => {
      const url = new URL(call.url);

      if (url.pathname.endsWith('/profile')) return ok({ emailAddress: mailbox, historyId: String(historyId) });

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
    const checked = () => calls.filter((call) => call.url.endsWith('/profile')).length;
    const histories = () => calls.filter((call) => call.url.includes('/history')).length;

    // A quiet inbox: its profile's history id unmoved, so not even its history is read.
    for (let check = 0; check < 6; check += 1) await nextCheck(workspace, checked);
    expect({ modelCalls: gateway.runs.length, histories: histories() }).toEqual({ modelCalls: 0, histories: 0 });

    // One letter to the inbox, and one the owner sent: only the letter is news.
    historyId = 102;
    records.push({ id: 101, message: 'm1', labels: ['INBOX', 'UNREAD'] }, { id: 102, message: 'm2', labels: ['SENT'] });
    await nextCheck(workspace, checked);
    await until(() => turnsOn(gateway, 'New mail in').length > 0, 'the check never woke the assistant');

    const woke = turnsOn(gateway, "New mail in Ashish's inbox");

    expect(firesOf(workspace).length).toBe(1);
    expect(askedOf(present(woke[0], 'the woken turn'))).toContain('New in the inbox:\\nAna <ana@example.com>: "Invoice m1" (m1)');
    expect(askedOf(present(woke[0], 'the woken turn'))).not.toContain('m2');
    expect(FAST_MODEL.endsWith(v.parse(ModelSchema, present(woke[0], 'the woken turn').query).model)).toBe(true);

    const after = gateway.runs.length;

    for (let check = 0; check < 3; check += 1) await nextCheck(workspace, checked);
    expect({ fires: firesOf(workspace).length, modelCalls: gateway.runs.length - after }).toEqual({ fires: 1, modelCalls: 0 });

    // A history id Gmail no longer keeps starts again from now: what came before it is not news, what comes after is.
    historyId = 300;
    kept = 200;
    records.push({ id: 250, message: 'm3', labels: ['INBOX'] });
    await nextCheck(workspace, checked);
    historyId = 301;
    records.push({ id: 301, message: 'm4', labels: ['INBOX'] });
    await nextCheck(workspace, checked);
    await until(() => turnsOn(gateway, '(m4)').length > 0, 'the mail after the restart never woke the assistant');
    expect({ fires: firesOf(workspace).length, m3: turnsOn(gateway, '(m3)').length }).toEqual({ fires: 2, m3: 0 });

    // Another mailbox connected starts again from its own now, and wakes nothing.
    mailbox = 'ashish@work.example';
    historyId = 5;
    await nextCheck(workspace, checked);
    expect(firesOf(workspace).length).toBe(2);
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
  const spec = v.parse(ScheduleSpecSchema, github.spec);

  // In place: the same trigger, its schedule kept, its check and tier the blueprint's; read by its program, no turn.
  expect({ id: github.id, cron: spec.cron, tier: spec.tier, reads: reads.length, modelCalls: gateway.runs.length })
    .toEqual({ id: present(before.get('GitHub check'), 'the v1 GitHub check').id, cron: '*/15 * * * *', tier: 'fast', reads: 1, modelCalls: 0 });
  expect(spec.check).toEqual(present(kinuBlueprint('personal-assistant'), 'the blueprint').automations.find(({ label }) => label === 'GitHub check')?.check);
  expect(spec.payload).toEqual({ prompt: expect.stringContaining('New GitHub notifications for ashish') });
  expect(after.get('Daily brief')).toEqual(before.get('Daily brief'));

  // Gmail's, kept unarmed while Google is not held, is armed as version 2's once it is.
  await workspace.agent.connectionsChanged(['github', 'google']);
  expect(v.parse(ScheduleSpecSchema, present((await triggers()).get('Gmail check'), 'the Gmail check').spec).check).toMatchObject({ reads: ['google'] });
});
