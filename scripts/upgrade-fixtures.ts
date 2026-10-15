/**
 * Staging's upgrade fixtures: data an older build wrote, read by the build that just deployed. The end-to-end tiers and
 * the evals make every workspace they read on the build they test, so none of them ever reads data an older build
 * made; this row does, on every staging deploy, as a post-publish row (scripts/ladder.ts), after the upload and the
 * tables walk. It first checks what the previous deploy seeded, then seeds afresh for the next one. A miss is red.
 *
 * CONTINUITY on two builtin sign-in accounts, whose ids no release moves, kept for good on staging and torn down by
 * nothing but this row's own turnover: the fixture account ({@link FIXTURE}) holds a workspace with a file, its chat,
 * a share received from the sender account's slate ({@link SENDER}), and a machine joined to the workspace. The check
 * signs both in and finds each as the previous deploy left it: its roster, the chat's history, the file's bytes, the
 * share, the machine. What it looks for is in a manifest the seed writes into both accounts' workspaces; a deploy whose
 * accounts hold no fixture at all seeds the first.
 *
 * A FRESH START on the eval identity, whose account a release may move (it is derived as the deployment's sign-in
 * derives one): a new workspace, a chat, a file, a share with its `devices` account and a machine joined, all made on
 * this build. The newest stays; the one before is removed once this one holds.
 *
 * Staging only: production holds no fixtures, and takes a release staging proved. The two accounts' passwords are
 * armada secrets ({@link FIXTURE_PASSWORD_ENV}, {@link SENDER_PASSWORD_ENV}); the accounts are made once, by the deployment's
 * owner's invites, and signed in to ever after.
 *
 *   bun scripts/upgrade-fixtures.ts     the deployment KINU_EVAL_ORIGIN names, as every post-publish row
 */
import * as v from 'valibot';
import { SLATES_ROOT } from '@kinu.run/core';
import { evalTargetVerdict } from '../packages/test-utils/src/eval-identity';
import { resolveWebIdentity, webHeaders } from '../evals/src/workspace-roster';
import { openSocketAs } from '../tests/first-run/public-socket';
import { deploymentOf } from './infra-manifest';

/** The fixture account, and the armada secret its password is held in. */
const FIXTURE = { email: 'upgrade-fixture@kinu.run', workspace: 'upgrade-fixture' } as const;

const FIXTURE_PASSWORD_ENV = 'KINU_UPGRADE_FIXTURE_PASSWORD';

/** The account whose slate the fixture account receives. */
const SENDER = { email: 'upgrade-sender@kinu.run', workspace: 'upgrade-sender' } as const;

const SENDER_PASSWORD_ENV = 'KINU_UPGRADE_SENDER_PASSWORD';

/** The eval identity's `devices` account, the address its fresh share names. */
const EVAL_RECIPIENT = 'eval-service+devices@kinu.run';

const SLATE = 'upgrade-slate';

/** Where each fixture workspace holds what the last seed made. */
const MANIFEST_PATH = 'notes/upgrade-manifest.json';

const BUDGET_MS = 180_000;

const NoteSchema = v.object({ path: v.string(), text: v.string() });

type Note = v.InferOutput<typeof NoteSchema>;

/** What a seed made, for the next deploy to find. */
const ManifestSchema = v.object({
  seededAt: v.string(),
  workspace: v.string(),
  note: NoteSchema,
  said: v.string(),
  senderWorkspace: v.string(),
  share: v.string(),
  device: v.string(),
  fresh: v.string(),
});

export type Manifest = v.InferOutput<typeof ManifestSchema>;

/** Whoever the row acts as: the deployment, the headers a request carries, and the address shares name. */
interface Account {
  readonly origin: string;
  readonly email: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** One verdict: what must hold, whether it did, and what the deployment answered where it did not. */
type Verdict = readonly [what: string, held: boolean, detail: string];

interface Request {
  readonly method?: string;
  readonly body?: string;
  readonly type?: string;
}

async function call(account: Account, path: string, init: Request = {}): Promise<{ status: number; text: string }> {
  const headers = new Headers(account.headers);

  if (init.body !== undefined) headers.set('content-type', init.type ?? 'application/json');
  const answer = await fetch(`${account.origin}${path}`, { method: init.method ?? 'GET', headers, body: init.body, signal: AbortSignal.timeout(60_000) });

  return { status: answer.status, text: await answer.text() };
}

/** Polls `read` until it answers true or the budget ends. */
async function until(read: () => Promise<boolean>): Promise<boolean> {
  const end = Date.now() + BUDGET_MS;

  while (Date.now() < end) {
    if (await read()) return true;
    await Bun.sleep(3_000);
  }

  return false;
}

/** A builtin account signed in with its password, as the login page signs in. */
async function signedIn(origin: string, email: string, secret: string): Promise<Account> {
  const password = process.env[secret] ?? '';

  if (password === '') throw new Error(`${secret} is not set, so ${email} cannot sign in: armada secret set ${secret}`);

  const answer = await fetch(`${origin}/api/auth/builtin/password/sign-in`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(60_000),
  });

  const cookie = answer.headers.get('set-cookie')?.split(';')[0];

  if (answer.status !== 200 || cookie === undefined) {
    throw new Error(`${email} answered ${String(answer.status)} at sign-in: ${(await answer.text()).slice(0, 300)}. It is made once, by an invite of `
      + `the deployment's owner, with the password ${secret} holds`);
  }

  return { origin, email, headers: { cookie, origin } };
}

// ── A workspace's reads and writes ─────────────────────────────────────────

const RosterSchema = v.object({ entries: v.array(v.looseObject({ name: v.string() })) });

/** The account's workspace whose name starts `prefix`, if it holds one. */
async function workspaceNamed(account: Account, prefix: string): Promise<string | undefined> {
  const roster = await call(account, '/api/user/workspaces');

  if (roster.status !== 200) throw new Error(`the roster of ${account.email} answered ${String(roster.status)}`);

  return v.parse(RosterSchema, JSON.parse(roster.text)).entries.find((entry) => entry.name.startsWith(prefix))?.name;
}

async function createWorkspace(account: Account, name: string): Promise<string> {
  const created = await call(account, '/api/user/workspaces', { method: 'POST', body: JSON.stringify({ name }) });

  if (created.status >= 300) throw new Error(`creating ${name} as ${account.email} answered ${String(created.status)}: ${created.text.slice(0, 300)}`);

  return v.parse(v.looseObject({ name: v.string() }), JSON.parse(created.text)).name;
}

function filePath(workspace: string, path: string): string {
  return `/api/workspaces/${encodeURIComponent(workspace)}/files?${new URLSearchParams({ executor: 'workspace', path }).toString()}`;
}

async function writeFile(account: Account, workspace: string, note: Note): Promise<void> {
  const put = await call(account, filePath(workspace, note.path), { method: 'PUT', body: note.text, type: 'application/octet-stream' });

  if (put.status >= 300) throw new Error(`writing ${note.path} as ${account.email} answered ${String(put.status)}: ${put.text.slice(0, 300)}`);
}

async function fileReads(account: Account, workspace: string, note: Note): Promise<Verdict> {
  const read = await call(account, filePath(workspace, note.path));

  return ['the file reads as written', read.status === 200 && read.text === note.text, `files answered ${String(read.status)}`];
}

/** The manifest a workspace holds, or null where it holds none. */
async function manifestIn(account: Account, workspace: string | undefined): Promise<Manifest | null> {
  if (workspace === undefined) return null;
  const read = await call(account, filePath(workspace, MANIFEST_PATH));

  return read.status === 200 ? v.parse(ManifestSchema, JSON.parse(read.text)) : null;
}

/** One chat turn in `workspace`, sent over the browser's own socket. */
async function chat(account: Account, workspace: string, said: string): Promise<void> {
  const socket = openSocketAs(account.origin, account.headers, `/agents/orchestrator-agent/${workspace}`, AbortSignal.timeout(BUDGET_MS));

  if (!await socket.opened) throw new Error(`the socket of ${workspace} was refused to ${account.email}`);
  console.log(`chat: ${workspace}: ${JSON.stringify(await socket.chat(said)).slice(0, 200)}`);
  socket.close('seeded');
}

async function historyOpens(account: Account, workspace: string, said: string): Promise<Verdict> {
  const history = await call(account, `/agents/orchestrator-agent/${workspace}/get-messages`);

  return ['the chat opens with what was said', history.status === 200 && history.text.includes(said), `history answered ${String(history.status)}`];
}

async function rosterNames(account: Account, workspace: string): Promise<Verdict> {
  return ['the roster names the workspace', await workspaceNamed(account, workspace) === workspace, `the roster of ${account.email} does not name ${workspace}`];
}

/** The slate in the sender's `workspace`, shared live with `recipient` anew: the share's id. */
async function shareSlate(sender: Account, workspace: string, recipient: string): Promise<string> {
  await writeFile(sender, workspace, { path: `${SLATES_ROOT}/${SLATE}/package.json`, text: JSON.stringify({ name: SLATE, main: 'server.ts', slate: { title: 'Upgrade fixture' } }) });
  await writeFile(sender, workspace, { path: `${SLATES_ROOT}/${SLATE}/server.ts`, text: 'export default { fetch: () => new Response("upgrade fixture") };\n' });
  const shared = await call(sender, '/api/shared/live', { method: 'POST', body: JSON.stringify({ workspace, slate: SLATE, visibility: 'users', emails: [recipient] }) });
  const share = /"id":"([^"]+)"/u.exec(shared.text)?.[1];

  if (shared.status !== 201 || share === undefined) throw new Error(`sharing the slate answered ${String(shared.status)}: ${shared.text.slice(0, 300)}`);

  return share;
}

async function holdsShare(recipient: Account, share: string, wait: boolean): Promise<Verdict> {
  const held = async () => (await call(recipient, '/api/shared')).text.includes(share);

  return [`${recipient.email} holds the share`, wait ? await until(held) : await held(), `/api/shared does not name ${share}`];
}

/** A machine joined to `workspace` by a ticket issued now: its device, or why there is none. */
async function joinMachine(account: Account, workspace: string): Promise<{ device?: string; why: string }> {
  const issued = await call(account, '/api/user/devices', { method: 'POST', body: JSON.stringify({ label: 'upgrade fixture', workspace }) });
  const ticket = /--join '([^']+)'/u.exec(issued.text)?.[1];

  if (ticket === undefined) return { why: `devices answered ${String(issued.status)}: ${issued.text.slice(0, 200)}` };
  const joined = await call(account, '/pc/join', { method: 'POST', body: JSON.stringify({ ticket, label: 'upgrade fixture' }) });
  const device = joined.status === 201 ? /"deviceId":"([^"]+)"/u.exec(joined.text)?.[1] : undefined;

  return device === undefined ? { why: `join answered ${String(joined.status)}: ${joined.text.slice(0, 200)}` } : { device, why: '' };
}

async function machineListed(account: Account, device: string): Promise<Verdict> {
  const devices = await call(account, '/api/user/devices');

  return ['the machine joined to the workspace is listed', devices.status === 200 && devices.text.includes(device), `devices answered ${String(devices.status)} without ${device}`];
}

async function removeMachine(account: Account, device: string): Promise<void> {
  await call(account, `/api/user/devices/${encodeURIComponent(device)}`, { method: 'DELETE' });
}

// ── Check, then seed ─────────────────────────────────────────────────────────

/** What the fixture accounts say of the previous seed: none (no seed ever completed here, or a reset took both
 *  accounts' storage, and with it the accounts), the manifest to check, or what was lost. */
type Previous = { readonly kind: 'none' } | { readonly kind: 'seeded'; readonly manifest: Manifest } | { readonly kind: 'lost'; readonly why: string };

/** One fixture account's workspace, if its roster names one, and the manifest it holds, if any. */
interface Held {
  readonly workspace?: string;
  readonly manifest: Manifest | null;
}

/** The previous seed, from the manifest both accounts' workspaces hold: a seed writes the two copies together and
 *  last, so the sender's copy without the fixture's is the fixture account's loss. */
export function previousSeed(fixture: Held, sender: Held): Previous {
  if (fixture.manifest !== null) return { kind: 'seeded', manifest: fixture.manifest };

  if (sender.manifest === null) return { kind: 'none' };

  return {
    kind: 'lost',
    why: fixture.workspace === undefined ? `${FIXTURE.email}'s roster no longer names its fixture workspace, which ${SENDER.email} still records`
      : `${fixture.workspace} no longer holds ${MANIFEST_PATH}, which ${SENDER.email} still holds`,
  };
}

/** The fixture account as the previous seed left it, on the build that just deployed. */
async function continuity(fixture: Account, manifest: Manifest): Promise<Verdict[]> {
  return [
    await rosterNames(fixture, manifest.workspace), await historyOpens(fixture, manifest.workspace, manifest.said),
    await fileReads(fixture, manifest.workspace, manifest.note), await holdsShare(fixture, manifest.share, false),
    await machineListed(fixture, manifest.device),
  ];
}

/** The eval identity's own account, and its `devices` account, which its fresh share names. */
interface EvalAccounts {
  readonly account: Account;
  readonly recipient: Account;
}

function evalAccounts(origin: string): EvalAccounts {
  const resolved = resolveWebIdentity(origin, { ...process.env, KINU_EVAL_ACCOUNT: undefined });

  if (resolved.kind !== 'ready') throw new Error(resolved.remedy);

  return {
    account: { origin, email: 'eval-service', headers: webHeaders(resolved.identity) },
    recipient: { origin, email: EVAL_RECIPIENT, headers: webHeaders({ ...resolved.identity, account: 'devices' }) },
  };
}

/** The eval identity's account from nothing, on this build: its workspace's name, and the verdicts. */
async function freshStart({ account, recipient }: EvalAccounts, stamp: string): Promise<{ workspace: string; verdicts: Verdict[] }> {
  // Not `eval-`, which the eval sweep deletes: the newest stays, and this row removes the one before.
  const workspace = await createWorkspace(account, `upgrade-fresh-${stamp}`);
  const note = { path: 'notes/fresh.md', text: `written on the build that just deployed, ${stamp}\n` };
  const said = `a fresh start ${stamp}: reply with one word`;

  await writeFile(account, workspace, note);
  await chat(account, workspace, said);
  const share = await shareSlate(account, workspace, EVAL_RECIPIENT);
  const joined = await joinMachine(account, workspace);

  // Removed at once: no first-run case may count it among the account's machines.
  if (joined.device !== undefined) await removeMachine(account, joined.device);

  return {
    workspace,
    verdicts: [
      await rosterNames(account, workspace), await historyOpens(account, workspace, said), await fileReads(account, workspace, note),
      await holdsShare(recipient, share, true), ['a machine joins by a ticket issued now', joined.device !== undefined, joined.why],
    ],
  };
}

/** The fixtures for the next deploy, made on this build and checked as made; their manifest is written into both
 *  accounts last, so a seed that fails leaves the previous one standing. */
async function seed(fixture: Account, sender: Account, made: { stamp: string; fresh: string }): Promise<{ manifest: Manifest; verdicts: Verdict[] }> {
  const workspace = await workspaceNamed(fixture, FIXTURE.workspace) ?? await createWorkspace(fixture, FIXTURE.workspace);
  const senderWorkspace = await workspaceNamed(sender, SENDER.workspace) ?? await createWorkspace(sender, SENDER.workspace);
  const note = { path: 'notes/upgrade.md', text: `written by the deploy of ${made.stamp}\n` };
  const said = `upgrade fixture ${made.stamp}: reply with one word`;

  await writeFile(fixture, workspace, note);
  await chat(fixture, workspace, said);
  const share = await shareSlate(sender, senderWorkspace, fixture.email);
  const joined = await joinMachine(fixture, workspace);
  const manifest: Manifest = { seededAt: made.stamp, workspace, note, said, senderWorkspace, share, device: joined.device ?? '', fresh: made.fresh };

  const verdicts: Verdict[] = [
    await historyOpens(fixture, workspace, said), await fileReads(fixture, workspace, note), await holdsShare(fixture, share, true),
    ['a machine joins the workspace by a ticket issued now', joined.device !== undefined, joined.why],
  ];

  if (verdicts.every(([, held]) => held)) {
    const text = JSON.stringify(manifest, null, 2);

    await writeFile(fixture, workspace, { path: MANIFEST_PATH, text });
    await writeFile(sender, senderWorkspace, { path: MANIFEST_PATH, text });
  }

  return { manifest, verdicts };
}

/** What the previous seed made that the new one replaces: its share, its machine, the eval account's fresh workspace. */
async function retire(accounts: { fixture: Account; sender: Account; eval: Account }, previous: Manifest): Promise<void> {
  await call(accounts.sender, '/api/shared/revoke', { method: 'POST', body: JSON.stringify({ workspace: previous.senderWorkspace, share: previous.share }) });
  await removeMachine(accounts.fixture, previous.device);
  await call(accounts.eval, `/api/user/workspaces/${encodeURIComponent(previous.fresh)}`, { method: 'DELETE' });
}

function printed(title: string, verdicts: readonly Verdict[]): boolean {
  for (const [what, held, detail] of verdicts) console.log(`${title}: ${held ? 'ok  ' : 'MISS'} ${what}${held ? '' : ` (${detail})`}`);

  return verdicts.every(([, held]) => held);
}

/** The previous seed checked, a fresh start made, the next seed made, and the previous one's leftovers removed. */
async function main(origin: string): Promise<boolean> {
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/gu, '').toLowerCase();
  const fixture = await signedIn(origin, FIXTURE.email, FIXTURE_PASSWORD_ENV);
  const sender = await signedIn(origin, SENDER.email, SENDER_PASSWORD_ENV);
  const fixtureWorkspace = await workspaceNamed(fixture, FIXTURE.workspace);
  const senderWorkspace = await workspaceNamed(sender, SENDER.workspace);

  const previous = previousSeed(
    { workspace: fixtureWorkspace, manifest: await manifestIn(fixture, fixtureWorkspace) },
    { workspace: senderWorkspace, manifest: await manifestIn(sender, senderWorkspace) },
  );

  const kept = previous.kind === 'seeded' ? printed(`continuity of the seed of ${previous.manifest.seededAt}`, await continuity(fixture, previous.manifest))
    : printed('continuity', previous.kind === 'lost' ? [['the previous seed is there', false, previous.why]] : []);

  if (previous.kind === 'none') console.log(`continuity: ${origin} holds no fixture yet; this deploy seeds the first`);
  const evals = evalAccounts(origin);
  const fresh = await freshStart(evals, stamp);
  const started = printed('a fresh start on the eval account', fresh.verdicts);
  const next = await seed(fixture, sender, { stamp, fresh: fresh.workspace });
  const seeded = printed('the seed for the next deploy', next.verdicts);

  if (seeded && previous.kind === 'seeded') {
    await retire({ fixture, sender, eval: evals.account }, previous.manifest);
  }

  return kept && started && seeded;
}

if (import.meta.main) {
  const target = evalTargetVerdict(process.env.KINU_EVAL_ORIGIN);

  if (target.kind === 'refused') {
    console.error(target.reason);
    process.exit(1);
  }

  if (target.origin !== deploymentOf('staging').origin) {
    console.log(`upgrade-fixtures: ${target.origin} is not staging, which alone keeps the fixtures; production takes a release staging proved`);
    process.exit(0);
  }

  process.exit(await main(target.origin) ? 0 : 1);
}
