/**
 * The rehearsal of a tables release on staging: what a release must keep, seeded under the build production serves,
 * and checked once the candidate deployed. Main runs it around two deploys; each step prints one line per verdict
 * and exits 1 on any miss.
 *
 *   bun scripts/tables-reset-rehearsal.ts seed <origin> <state.json>
 *   bun scripts/tables-reset-rehearsal.ts check <origin> <state.json>
 *
 * CONTINUITY is proven on builtin sign-in accounts, whose ids no release moves. `seed` gives the first a workspace
 * with a file and a chat turn, a device join issued for that workspace, and a share received from a slate of the
 * second account's; `check` signs it in again and finds its roster, the chat's history, the file and the share as they
 * were, and joins a machine to the workspace by a new ticket (the one issued before was a ticket of 30 minutes, which
 * the repair refills). The workspaces are not named `eval-`, which the eval sweep deletes, since deploys run between.
 *
 * A FRESH START is proven on the eval identity (`resolveWebIdentity`), whose account a release may move, since it is
 * derived as the deployment's sign-in derives one: `check` makes it a new workspace, chats, writes and reads a file,
 * shares a slate with its `devices` account, and joins a machine.
 *
 * KINU_REHEARSAL_BUILTIN_EMAIL and _PASSWORD name the first builtin account, KINU_REHEARSAL_SENDER_EMAIL and _PASSWORD
 * the second. One that cannot sign in registers: the first with KINU_REHEARSAL_BUILTIN_SETUP (the deployment's setup
 * token) or _INVITE, the second with KINU_REHEARSAL_SENDER_INVITE, or else an invite the first makes as the owner.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { SLATES_ROOT } from '@kinu.run/core';
import { resolveWebIdentity, webHeaders } from '../evals/src/workspace-roster';
import { openSocketAs } from '../tests/first-run/public-socket';

const NoteSchema = v.object({ path: v.string(), text: v.string() });

const StateSchema = v.object({
  builtin: v.object({
    email: v.string(), workspace: v.string(), file: NoteSchema, said: v.string(), share: v.string(), sender: v.string(), joinDevice: v.string(),
  }),
});

type State = v.InferOutput<typeof StateSchema>;

const SLATE = 'rehearsal-slate';

/** The eval identity's `devices` account, the address its fresh share names. */
const EVAL_RECIPIENT = 'eval-service+devices@kinu.run';

const BUDGET_MS = 180_000;

/** Whoever the rehearsal acts as: the deployment, the headers a request carries, and the address shares name. */
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

// ── Builtin sign-in ──────────────────────────────────────────────────────────

/** What builtin sign-in and registration are posted: registration adds its grant. */
interface BuiltinSignIn {
  readonly email: string;
  readonly password: string;
  readonly invite?: string;
  readonly setup?: string;
}

/** The builtin account `prefix` names in the environment, or why it cannot be read. */
function credentials(prefix: 'BUILTIN' | 'SENDER'): BuiltinSignIn {
  const read = (name: string) => process.env[`KINU_REHEARSAL_${prefix}_${name}`];
  const email = read('EMAIL') ?? '';
  const password = read('PASSWORD') ?? '';

  if (email === '' || password === '') throw new Error(`the rehearsal proves continuity on builtin accounts: set KINU_REHEARSAL_${prefix}_EMAIL and _PASSWORD`);

  return { email, password, invite: read('INVITE'), setup: read('SETUP') };
}

/** A builtin account signed in, registered first where it cannot sign in and the grant to register is at hand. */
async function builtinAccount(origin: string, signIn: BuiltinSignIn): Promise<Account> {
  const post = (path: string, body: BuiltinSignIn) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });

  let answer = await post('/api/auth/builtin/password/sign-in', { email: signIn.email, password: signIn.password });

  if (answer.status === 401 && (signIn.invite !== undefined || signIn.setup !== undefined)) answer = await post('/api/auth/builtin/password/register', signIn);
  const cookie = answer.headers.get('set-cookie')?.split(';')[0];

  if (answer.status !== 200 || cookie === undefined) throw new Error(`signing in as ${signIn.email} answered ${String(answer.status)}: ${(await answer.text()).slice(0, 300)}`);

  return { origin, email: signIn.email, headers: { cookie, origin } };
}

/** Whether `signIn` signs in as it is. */
async function signsIn(origin: string, signIn: BuiltinSignIn): Promise<boolean> {
  const answer = await fetch(`${origin}/api/auth/builtin/password/sign-in`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email: signIn.email, password: signIn.password }), signal: AbortSignal.timeout(60_000),
  });

  return answer.status === 200;
}

/** The second builtin account: signed in, or registered by its own invite or one the first makes as the owner. */
async function senderAccount(first: Account): Promise<Account> {
  const signIn = credentials('SENDER');

  if (signIn.invite !== undefined || await signsIn(first.origin, signIn)) return await builtinAccount(first.origin, signIn);
  const made = await call(first, '/api/user/builtin-auth/invites', { method: 'POST', body: JSON.stringify({ email: signIn.email }) });
  const invite = /[?&]invite=([^&"]+)/u.exec(made.text)?.[1];

  if (invite === undefined) throw new Error(`${signIn.email} cannot sign in, and ${first.email} could not invite it (${String(made.status)}): set KINU_REHEARSAL_SENDER_INVITE`);

  return await builtinAccount(first.origin, { ...signIn, invite });
}

// ── A workspace's reads and writes ─────────────────────────────────────────

async function createWorkspace(account: Account, name: string): Promise<string> {
  const created = await call(account, '/api/user/workspaces', { method: 'POST', body: JSON.stringify({ name }) });

  if (created.status >= 300) throw new Error(`creating ${name} as ${account.email} answered ${String(created.status)}: ${created.text.slice(0, 300)}`);

  return v.parse(v.looseObject({ name: v.string() }), JSON.parse(created.text)).name;
}

function filePath(workspace: string, path: string): string {
  return `/api/workspaces/${encodeURIComponent(workspace)}/files?${new URLSearchParams({ executor: 'workspace', path }).toString()}`;
}

async function writeFile(account: Account, workspace: string, note: v.InferOutput<typeof NoteSchema>): Promise<void> {
  const put = await call(account, filePath(workspace, note.path), { method: 'PUT', body: note.text, type: 'application/octet-stream' });

  if (put.status >= 300) throw new Error(`writing ${note.path} as ${account.email} answered ${String(put.status)}: ${put.text.slice(0, 300)}`);
}

async function fileReads(account: Account, workspace: string, note: v.InferOutput<typeof NoteSchema>): Promise<Verdict> {
  const read = await call(account, filePath(workspace, note.path));

  return ['the file reads as written', read.status === 200 && read.text === note.text, `files answered ${String(read.status)}`];
}

/** One chat turn in `workspace`, sent over the browser's own socket. */
async function chat(account: Account, workspace: string, said: string): Promise<void> {
  const socket = openSocketAs(account.origin, account.headers, `/agents/orchestrator-agent/${workspace}`, AbortSignal.timeout(BUDGET_MS));

  if (!await socket.opened) throw new Error(`the socket of ${workspace} was refused to ${account.email}`);
  console.log(`chat: ${workspace}: ${JSON.stringify(await socket.chat(said)).slice(0, 200)}`);
  socket.close('rehearsed');
}

async function historyOpens(account: Account, workspace: string, said: string): Promise<Verdict> {
  const history = await call(account, `/agents/orchestrator-agent/${workspace}/get-messages`);

  return ['chat opens with what was said', history.status === 200 && history.text.includes(said), `history answered ${String(history.status)}`];
}

async function rosterNames(account: Account, workspace: string): Promise<Verdict> {
  const roster = await call(account, '/api/user/workspaces');

  return ['the roster names the workspace', roster.status === 200 && roster.text.includes(workspace), `workspaces answered ${String(roster.status)}`];
}

/** A slate in the sender's `workspace`, shared live with `recipient`: the share's id. */
async function shareSlate(sender: Account, workspace: string, recipient: string): Promise<string> {
  await writeFile(sender, workspace, { path: `${SLATES_ROOT}/${SLATE}/package.json`, text: JSON.stringify({ name: SLATE, main: 'server.ts', slate: { title: 'Rehearsal' } }) });
  await writeFile(sender, workspace, { path: `${SLATES_ROOT}/${SLATE}/server.ts`, text: 'export default { fetch: () => new Response("rehearsal") };\n' });
  const shared = await call(sender, '/api/shared/live', { method: 'POST', body: JSON.stringify({ workspace, slate: SLATE, visibility: 'users', emails: [recipient] }) });
  const share = /"id":"([^"]+)"/u.exec(shared.text)?.[1];

  if (shared.status !== 201 || share === undefined) throw new Error(`sharing the slate answered ${String(shared.status)}: ${shared.text.slice(0, 300)}`);

  return share;
}

async function holdsShare(recipient: Account, share: string, wait: boolean): Promise<Verdict> {
  const held = async () => (await call(recipient, '/api/shared')).text.includes(share);

  return [`${recipient.email} holds the share`, wait ? await until(held) : await held(), `/api/shared does not name ${share}`];
}

/** A join issued for `workspace`: its device, and the ticket a machine joins by (none before tickets were). */
async function issueJoin(account: Account, workspace: string): Promise<{ status: number; device?: string; ticket?: string; text: string }> {
  const issued = await call(account, '/api/user/devices', { method: 'POST', body: JSON.stringify({ label: 'rehearsal', workspace }) });

  return { status: issued.status, device: /"deviceId":"([^"]+)"/u.exec(issued.text)?.[1], ticket: /--join '([^']+)'/u.exec(issued.text)?.[1], text: issued.text };
}

/** A machine joins `workspace` by a ticket issued now, is listed among the account's devices, and is removed again. */
async function joinsNow(account: Account, workspace: string): Promise<Verdict[]> {
  const issued = await issueJoin(account, workspace);

  if (issued.ticket === undefined) return [['a device join is issued', false, `devices answered ${String(issued.status)}: ${issued.text.slice(0, 200)}`]];
  const joined = await call(account, '/pc/join', { method: 'POST', body: JSON.stringify({ ticket: issued.ticket, label: 'rehearsal check' }) });
  const device = /"deviceId":"([^"]+)"/u.exec(joined.text)?.[1];
  const listed = device !== undefined && (await call(account, '/api/user/devices')).text.includes(device);

  if (device !== undefined) await call(account, `/api/user/devices/${encodeURIComponent(device)}`, { method: 'DELETE' });

  return [['a machine joins by a ticket issued now, and is listed', joined.status === 201 && listed, `join answered ${String(joined.status)}: ${joined.text.slice(0, 200)}`]];
}

// ── Seed and check ───────────────────────────────────────────────────────────

function printed(title: string, verdicts: readonly Verdict[]): boolean {
  for (const [what, held, detail] of verdicts) console.log(`${title}: ${held ? 'ok  ' : 'MISS'} ${what}${held ? '' : ` (${detail})`}`);

  return verdicts.every(([, held]) => held);
}

async function seed(origin: string, file: string): Promise<boolean> {
  const stamp = new Date().toISOString().replace(/[-:T]|\.\d+Z/gu, '').slice(0, 12);
  const first = await builtinAccount(origin, credentials('BUILTIN'));
  const sender = await senderAccount(first);
  const workspace = await createWorkspace(first, `rehearsal-builtin-${stamp}`);
  const note = { path: 'notes/rehearsal.md', text: `kept across the release, written ${stamp}\n` };
  const said = `rehearsal ${stamp}: reply with one word`;

  await writeFile(first, workspace, note);
  await chat(first, workspace, said);
  const share = await shareSlate(sender, await createWorkspace(sender, `rehearsal-sender-${stamp}`), first.email);
  const join = await issueJoin(first, workspace);
  const state: State = { builtin: { email: first.email, workspace, file: note, said, share, sender: sender.email, joinDevice: join.device ?? '' } };

  writeFileSync(file, JSON.stringify(state, null, 2));
  console.log(`seed: ${first.email}: workspace ${workspace}, share ${share} from ${sender.email}, device join ${join.device ?? 'none'}`);

  // Each held now, so a miss at the check is what the release lost.
  return printed('seed', [
    await historyOpens(first, workspace, said), await fileReads(first, workspace, note), await holdsShare(first, share, true),
    ['a device join is issued for the workspace', join.status === 201 && join.device !== undefined, `devices answered ${String(join.status)}: ${join.text.slice(0, 200)}`],
  ]);
}

/** The builtin account as the seed left it, on the build the release deployed. */
async function continuity(origin: string, seeded: State['builtin']): Promise<Verdict[]> {
  const account = await builtinAccount(origin, credentials('BUILTIN'));

  if (account.email !== seeded.email) throw new Error(`the state was seeded as ${seeded.email}, and KINU_REHEARSAL_BUILTIN_EMAIL is ${account.email}`);

  return [
    ['it signs in, under the id it had', true, ''],
    await rosterNames(account, seeded.workspace), await historyOpens(account, seeded.workspace, seeded.said),
    await fileReads(account, seeded.workspace, seeded.file), await holdsShare(account, seeded.share, false),
    ...await joinsNow(account, seeded.workspace),
  ];
}

/** The eval identity's account from nothing: a workspace, a chat, a file, a share and a join, all made now. */
async function freshStart(origin: string): Promise<Verdict[]> {
  const resolved = resolveWebIdentity(origin, { ...process.env, KINU_EVAL_ACCOUNT: undefined });

  if (resolved.kind !== 'ready') throw new Error(resolved.remedy);
  const account: Account = { origin, email: 'eval-service', headers: webHeaders(resolved.identity) };
  const recipient: Account = { origin, email: EVAL_RECIPIENT, headers: webHeaders({ ...resolved.identity, account: 'devices' }) };
  // `eval-`: the eval sweep deletes it after its lease, as every eval workspace.
  const workspace = await createWorkspace(account, `eval-rehearsal-${Date.now().toString(36)}`);
  const note = { path: 'notes/fresh.md', text: 'written after the release\n' };
  const said = `a fresh start ${workspace}: reply with one word`;

  await writeFile(account, workspace, note);
  await chat(account, workspace, said);
  const share = await shareSlate(account, workspace, EVAL_RECIPIENT);

  return [
    await rosterNames(account, workspace), await historyOpens(account, workspace, said), await fileReads(account, workspace, note),
    await holdsShare(recipient, share, true), ...await joinsNow(account, workspace),
  ];
}

async function check(origin: string, file: string): Promise<boolean> {
  const state = v.parse(StateSchema, JSON.parse(readFileSync(file, 'utf8')));
  const kept = printed(`check ${state.builtin.email} (continuity)`, await continuity(origin, state.builtin));
  const fresh = printed('check eval-service (a fresh start)', await freshStart(origin));

  return kept && fresh;
}

if (import.meta.main) {
  const [command, origin, file] = process.argv.slice(2);

  if ((command !== 'seed' && command !== 'check') || origin === undefined || file === undefined) {
    console.error('usage: bun scripts/tables-reset-rehearsal.ts seed|check <origin> <state.json>');
    process.exit(2);
  }

  process.exit(await (command === 'seed' ? seed(origin, file) : check(origin, file)) ? 0 : 1);
}
