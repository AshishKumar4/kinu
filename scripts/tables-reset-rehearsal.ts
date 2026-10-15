/**
 * The rehearsal of a tables reset on staging: what a release must keep, seeded under the build production serves,
 * and checked once the candidate deployed. Main runs it around two deploys; each step prints one line per verdict
 * and exits 1 on any miss.
 *
 *   bun scripts/tables-reset-rehearsal.ts seed <origin> <state.json>    a workspace with a chat and files, a slate
 *                                                                       shared with a second account, a device join
 *   bun scripts/tables-reset-rehearsal.ts check <origin> <state.json>   the roster, the chat and the files open, the
 *                                                                       share is still held, and a device joins now
 *
 * The workspace is not named `eval-`, which the eval sweep deletes after its lease, since deploys run in between.
 * Credentials are the eval identity's (`resolveWebIdentity`): its owner, and its `devices` account as the recipient.
 * A release may move the eval identity to another account (it is derived as the deployment's sign-in derives one), so
 * the rehearsal also seeds a builtin sign-in account, a real one, whose id must not move: a workspace and a file,
 * which `check` must find on the same account. KINU_REHEARSAL_BUILTIN_EMAIL and KINU_REHEARSAL_BUILTIN_PASSWORD name
 * it; KINU_REHEARSAL_BUILTIN_INVITE (or _SETUP, the deployment's setup token) registers it if it cannot sign in.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { SLATES_ROOT } from '@kinu.run/core';
import { createWorkspace, resolveWebIdentity, webHeaders, type PublicWebIdentity } from '../evals/src/workspace-roster';
import { openPublicSocket } from '../tests/first-run/public-socket';

const NoteSchema = v.object({ path: v.string(), text: v.string() });

const StateSchema = v.object({
  workspace: v.string(),
  file: NoteSchema,
  said: v.string(),
  slate: v.string(),
  share: v.string(),
  recipient: v.string(),
  joinDevice: v.string(),
  builtin: v.optional(v.object({ email: v.string(), workspace: v.string(), file: NoteSchema })),
});

type State = v.InferOutput<typeof StateSchema>;

const SLATE = 'rehearsal-slate';

/** The recipient: the eval identity's `devices` account, whose address the share names. */
const RECIPIENT = 'eval-service+devices@kinu.run';

const BUDGET_MS = 180_000;

function identities(origin: string) {
  const resolved = resolveWebIdentity(origin, { ...process.env, KINU_EVAL_ACCOUNT: undefined });

  if (resolved.kind !== 'ready') throw new Error(resolved.remedy);

  const recipient: PublicWebIdentity = { ...resolved.identity, account: 'devices' };

  return { owner: resolved.identity, recipient };
}

async function call(origin: string, identity: PublicWebIdentity, path: string, init: { method?: string; body?: string; type?: string } = {}): Promise<{ status: number; text: string }> {
  const headers = new Headers(webHeaders(identity));

  if (init.body !== undefined) headers.set('content-type', init.type ?? 'application/json');
  const answer = await fetch(`${origin}${path}`, { method: init.method ?? 'GET', headers, body: init.body, signal: AbortSignal.timeout(60_000) });

  return { status: answer.status, text: await answer.text() };
}

/** A workspace as its owner reaches it. */
interface Owned {
  readonly origin: string;
  readonly owner: PublicWebIdentity;
  readonly workspace: string;
}

async function writeFile(at: Owned, path: string, text: string): Promise<void> {
  const query = new URLSearchParams({ executor: 'workspace', path });
  const put = await call(at.origin, at.owner, `/api/workspaces/${encodeURIComponent(at.workspace)}/files?${query.toString()}`, { method: 'PUT', body: text, type: 'application/octet-stream' });

  if (put.status >= 300) throw new Error(`writing ${path} answered ${String(put.status)}: ${put.text.slice(0, 300)}`);
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

/** What builtin sign-in and registration are posted: registration adds its grant. */
interface BuiltinSignIn {
  readonly email: string;
  readonly password: string;
  readonly invite?: string;
  readonly setup?: string;
}

/** The builtin account's session cookie, signed in (or registered, with an invite or the setup token); null where
 *  the rehearsal names none. */
async function builtinSession(origin: string): Promise<{ readonly email: string; readonly cookie: string } | null> {
  const email = process.env.KINU_REHEARSAL_BUILTIN_EMAIL ?? '';
  const password = process.env.KINU_REHEARSAL_BUILTIN_PASSWORD ?? '';

  if (email === '' || password === '') return null;

  const post = (path: string, body: BuiltinSignIn) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });

  const invite = process.env.KINU_REHEARSAL_BUILTIN_INVITE;
  const setup = process.env.KINU_REHEARSAL_BUILTIN_SETUP;
  let answer = await post('/api/auth/builtin/password/sign-in', { email, password });

  if (answer.status === 401 && (invite !== undefined || setup !== undefined)) answer = await post('/api/auth/builtin/password/register', { email, password, invite, setup });
  const cookie = answer.headers.get('set-cookie')?.split(';')[0];

  if (answer.status !== 200 || cookie === undefined) throw new Error(`signing in as ${email} answered ${String(answer.status)}: ${(await answer.text()).slice(0, 300)}`);

  return { email, cookie };
}

/** One request as the builtin account's browser makes it. */
async function asBuiltin(origin: string, cookie: string, path: string, init: { method?: string; body?: string; type?: string } = {}): Promise<{ status: number; text: string }> {
  const headers = new Headers({ cookie, origin });

  if (init.body !== undefined) headers.set('content-type', init.type ?? 'application/json');
  const answer = await fetch(`${origin}${path}`, { method: init.method ?? 'GET', headers, body: init.body, signal: AbortSignal.timeout(60_000) });

  return { status: answer.status, text: await answer.text() };
}

/** A workspace and a file on the builtin account, if the rehearsal names one. */
async function seedBuiltin(origin: string, stamp: string): Promise<State['builtin']> {
  const session = await builtinSession(origin);

  if (session === null) return undefined;
  const created = await asBuiltin(origin, session.cookie, '/api/user/workspaces', { method: 'POST', body: JSON.stringify({ name: `rehearsal-builtin-${stamp}` }) });
  const workspace = /"name":"([^"]+)"/u.exec(created.text)?.[1];

  if (created.status >= 300 || workspace === undefined) throw new Error(`the builtin account's workspace answered ${String(created.status)}: ${created.text.slice(0, 300)}`);
  const note = { path: 'notes/builtin.md', text: `a real account's file, written ${stamp}\n` };
  const query = new URLSearchParams({ executor: 'workspace', path: note.path });
  const put = await asBuiltin(origin, session.cookie, `/api/workspaces/${encodeURIComponent(workspace)}/files?${query.toString()}`, { method: 'PUT', body: note.text, type: 'application/octet-stream' });

  if (put.status >= 300) throw new Error(`writing the builtin account's file answered ${String(put.status)}: ${put.text.slice(0, 300)}`);
  console.log(`seed: builtin account ${session.email}: workspace ${workspace}; file ${note.path}`);

  return { email: session.email, workspace, file: note };
}

/** The builtin account's verdicts: signed in again, its roster and its file as they were. */
async function checkBuiltin(origin: string, seeded: NonNullable<State['builtin']>): Promise<Array<[string, boolean, string]>> {
  const session = await builtinSession(origin);

  if (session === null) return [['the builtin account signs in', false, 'KINU_REHEARSAL_BUILTIN_EMAIL and _PASSWORD are not set']];
  const roster = await asBuiltin(origin, session.cookie, '/api/user/workspaces');
  const query = new URLSearchParams({ executor: 'workspace', path: seeded.file.path });
  const read = await asBuiltin(origin, session.cookie, `/api/workspaces/${encodeURIComponent(seeded.workspace)}/files?${query.toString()}`);

  return [
    ['the builtin account keeps its id: its roster names its workspace', roster.status === 200 && roster.text.includes(seeded.workspace), `workspaces answered ${String(roster.status)}`],
    ['the builtin account\'s file reads as written', read.status === 200 && read.text === seeded.file.text, `files answered ${String(read.status)}`],
  ];
}

async function seed(origin: string, file: string): Promise<boolean> {
  const { owner, recipient } = identities(origin);
  const stamp = new Date().toISOString().replace(/[-:T]|\.\d+Z/gu, '').slice(0, 12);
  const workspace = await createWorkspace(origin, owner, { name: `rehearsal-tables-${stamp}` });
  const note = { path: 'notes/rehearsal.md', text: `kept across the tables reset, written ${stamp}\n` };

  const at: Owned = { origin, owner, workspace };

  await writeFile(at, note.path, note.text);
  await writeFile(at, `${SLATES_ROOT}/${SLATE}/package.json`, JSON.stringify({ name: SLATE, main: 'server.ts', slate: { title: 'Rehearsal' } }));
  await writeFile(at, `${SLATES_ROOT}/${SLATE}/server.ts`, 'export default { fetch: () => new Response("rehearsal") };\n');

  const said = `rehearsal ${stamp}: reply with one word`;
  const socket = openPublicSocket(origin, owner, `/agents/orchestrator-agent/${workspace}`, AbortSignal.timeout(BUDGET_MS));

  if (!await socket.opened) throw new Error(`the workspace's socket was refused at ${origin}`);
  console.log(`seed: chat ${JSON.stringify(await socket.chat(said)).slice(0, 200)}`);
  socket.close('seeded');

  const shared = await call(origin, owner, '/api/shared/live', { method: 'POST', body: JSON.stringify({ workspace, slate: SLATE, visibility: 'users', emails: [RECIPIENT] }) });
  const share = /"id":"([^"]+)"/u.exec(shared.text)?.[1];

  if (shared.status !== 201 || share === undefined) throw new Error(`sharing the slate answered ${String(shared.status)}: ${shared.text.slice(0, 300)}`);
  const received = await until(async () => (await call(origin, recipient, '/api/shared')).text.includes(share));
  const joined = await call(origin, owner, '/api/user/devices', { method: 'POST', body: JSON.stringify({ label: 'rehearsal join' }) });
  const joinDevice = /"deviceId":"([^"]+)"/u.exec(joined.text)?.[1] ?? '';

  const state: State = { workspace, file: note, said, slate: SLATE, share, recipient: RECIPIENT, joinDevice };
  const builtin = await seedBuiltin(origin, stamp);

  if (builtin !== undefined) state.builtin = builtin;

  writeFileSync(file, JSON.stringify(state, null, 2));
  console.log(`seed: workspace ${workspace}; file ${note.path}; share ${share} ${received ? 'received' : 'NOT received'} by ${RECIPIENT}; `
    + `device join ${joined.status === 201 ? joinDevice : `answered ${String(joined.status)}`}`);

  return received && joined.status === 201;
}

async function check(origin: string, file: string): Promise<boolean> {
  const { owner, recipient } = identities(origin);
  const state = v.parse(StateSchema, JSON.parse(readFileSync(file, 'utf8')));
  const verdicts: Array<[string, boolean, string]> = [];
  const roster = await call(origin, owner, '/api/user/workspaces');

  verdicts.push(['the owner\'s roster still names the workspace', roster.status === 200 && roster.text.includes(state.workspace), `workspaces answered ${String(roster.status)}`]);
  const history = await call(origin, owner, `/agents/orchestrator-agent/${state.workspace}/get-messages`);

  verdicts.push(['chat opens with what was said', history.status === 200 && history.text.includes(state.said), `history answered ${String(history.status)}`]);
  const query = new URLSearchParams({ executor: 'workspace', path: state.file.path });
  const read = await call(origin, owner, `/api/workspaces/${encodeURIComponent(state.workspace)}/files?${query.toString()}`);

  verdicts.push(['the file reads as written', read.status === 200 && read.text === state.file.text, `files answered ${String(read.status)}`]);
  const shares = await call(origin, recipient, '/api/shared');

  verdicts.push(['the recipient still holds the share', shares.text.includes(state.share), `shared answered ${String(shares.status)}`]);
  const issued = await call(origin, owner, '/api/user/devices', { method: 'POST', body: JSON.stringify({ label: 'rehearsal check', workspace: state.workspace }) });
  const ticket = /--join '([^']+)'/u.exec(issued.text)?.[1];

  verdicts.push(['a device join is issued', issued.status === 201 && ticket !== undefined, `devices answered ${String(issued.status)}: ${issued.text.slice(0, 200)}`]);

  if (ticket !== undefined) {
    const joined = await call(origin, owner, '/pc/join', { method: 'POST', body: JSON.stringify({ ticket, label: 'rehearsal check' }) });
    const device = /"deviceId":"([^"]+)"/u.exec(joined.text)?.[1];

    verdicts.push(['the machine joins by its ticket', joined.status === 201 && device !== undefined, `join answered ${String(joined.status)}: ${joined.text.slice(0, 200)}`]);

    if (device !== undefined) await call(origin, owner, `/api/user/devices/${encodeURIComponent(device)}`, { method: 'DELETE' });
  }

  if (state.builtin !== undefined) verdicts.push(...await checkBuiltin(origin, state.builtin));

  for (const [what, held, detail] of verdicts) console.log(`check: ${held ? 'ok  ' : 'MISS'} ${what}${held ? '' : ` (${detail})`}`);

  return verdicts.every(([, held]) => held);
}

if (import.meta.main) {
  const [command, origin, file] = process.argv.slice(2);

  if ((command !== 'seed' && command !== 'check') || origin === undefined || file === undefined) {
    console.error('usage: bun scripts/tables-reset-rehearsal.ts seed|check <origin> <state.json>');
    process.exit(2);
  }

  process.exit(await (command === 'seed' ? seed(origin, file) : check(origin, file)) ? 0 : 1);
}
