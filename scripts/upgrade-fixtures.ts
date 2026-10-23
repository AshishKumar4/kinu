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
 * share, the machine.
 *
 * THE ANCHOR. What the check looks for is the manifest the last seed wrote to the releases bucket
 * ({@link UPGRADE_ANCHOR_KEY}), outside every workspace it checks, so losing them all is a loss and never a first run.
 * Only an absent anchor seeds a first: a deployment that never seeded, or one a full reset emptied (reset.ts deletes the
 * anchor with the classes). A continuity miss is red and changes nothing: no fresh start, no seed, no retirement, so the
 * baseline that failed stays for a person to look at, and every rerun stays red until one does.
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
import { generateKeyPairSync } from 'node:crypto';
import * as v from 'valibot';
import { SLATES_ROOT, UPGRADE_FIXTURE_ACCOUNTS, VfsRevisionSchema } from '@kinu.run/core';
import { evalTargetVerdict } from '../packages/test-utils/src/eval-identity';
import { deleteWorkspace, listWorkspaces, resolveWebIdentity, webHeaders, type PublicWebIdentity } from '../evals/src/workspace-roster';
import { openSocketAs } from '../tests/first-run/public-socket';
import { r2ObjectText, r2PutJson } from './cloudflare-rest';
import { requireCloudflareAccountId } from './infra-cloudflare';
import { bucketOf, deployedConfig, deploymentOf } from './infra-manifest';
import { LATEST_RESET_KEY, ResetSchema, UPGRADE_ANCHOR_KEY } from './reset';
import { rowNotice } from './row-verdicts';

/** The fixture account, and the armada secret its password is held in. */
const FIXTURE = { email: UPGRADE_FIXTURE_ACCOUNTS.fixture, workspace: 'upgrade-fixture' } as const;

const FIXTURE_PASSWORD_ENV = 'KINU_UPGRADE_FIXTURE_PASSWORD';

/** The account whose slate the fixture account receives. */
const SENDER = { email: UPGRADE_FIXTURE_ACCOUNTS.sender, workspace: 'upgrade-sender' } as const;

const SENDER_PASSWORD_ENV = 'KINU_UPGRADE_SENDER_PASSWORD';

/** The eval identity's `devices` account, the address its fresh share names. */
const EVAL_RECIPIENT = 'eval-service+devices@kinu.run';

const SLATE = 'upgrade-slate';

/** What every machine this row joins is labelled, so a later run finds the ones no anchor keeps. */
const MACHINE_LABEL = 'upgrade fixture';

/** What every eval workspace this row makes is named from, for the same reason. */
const FRESH_PREFIX = 'upgrade-fresh-';

/** The two paths a seed's file takes in turn, so a seed never writes over the file the baseline it replaces holds. */
const NOTE_PATHS = ['notes/upgrade-a.md', 'notes/upgrade-b.md'] as const;

const BUDGET_MS = 180_000;

const NoteSchema = v.object({ path: v.string(), text: v.string() });

type Note = v.InferOutput<typeof NoteSchema>;

/** What a seed made, for the next deploy to find: the anchor. */
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
export type Verdict = readonly [what: string, held: boolean, detail: string];

interface Request {
  readonly method?: string;
  readonly body?: string;
  readonly type?: string;
  /** The revision a checked write is made over (`If-Match`). */
  readonly ifMatch?: string;
}

async function call(account: Account, path: string, init: Request = {}): Promise<{ status: number; text: string }> {
  const headers = new Headers(account.headers);

  if (init.body !== undefined) headers.set('content-type', init.type ?? 'application/json');

  if (init.ifMatch !== undefined) headers.set('if-match', init.ifMatch);
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

/** A builtin account signed in with its password, as the login page signs in; or the deployment's refusal, said whole. */
async function signedIn(origin: string, email: string, secret: string): Promise<Account | { readonly refused: string }> {
  const password = process.env[secret] ?? '';

  if (password === '') throw new Error(`${secret} is not set, so ${email} cannot sign in: armada secret set ${secret}`);

  const answer = await fetch(`${origin}/api/auth/builtin/password/sign-in`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(60_000),
  });

  const cookie = answer.headers.get('set-cookie')?.split(';')[0];

  if (answer.status !== 200 || cookie === undefined) {
    return { refused: `${email} answered ${String(answer.status)} at sign-in: ${(await answer.text()).slice(0, 300)}. It is made once, by an invite of `
      + `the deployment's owner, with the password ${secret} holds` };
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

const ConflictSchema = v.object({ revision: VfsRevisionSchema });

type Revision = v.InferOutput<typeof VfsRevisionSchema>;

/** `note` written as the file manager writes one: created where it is absent; where it is there (an earlier seed's),
 *  over the revision the refusal names, which is the revision a reader would have opened. */
async function writeFile(account: Account, workspace: string, note: Note): Promise<void> {
  const put = (revision?: Revision) => {
    const request: Request = { method: 'PUT', body: note.text, type: 'application/octet-stream' };

    return call(account, filePath(workspace, note.path), revision === undefined ? request : { ...request, ifMatch: JSON.stringify(revision) });
  };

  let written = await put();
  const held = written.status === 412 ? v.safeParse(v.pipe(v.string(), v.parseJson(), ConflictSchema), written.text) : null;

  if (held?.success === true) written = await put(held.output.revision);

  if (written.status >= 300) throw new Error(`writing ${note.path} as ${account.email} answered ${String(written.status)}: ${written.text.slice(0, 300)}`);
}

async function fileReads(account: Account, workspace: string, note: Note): Promise<Verdict> {
  const read = await call(account, filePath(workspace, note.path));

  return ['the file reads as written', read.status === 200 && read.text === note.text, `files answered ${String(read.status)}`];
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
  const issued = await call(account, '/api/user/devices', { method: 'POST', body: JSON.stringify({ label: MACHINE_LABEL, workspace }) });
  const ticket = /--join '([^']+)'/u.exec(issued.text)?.[1];

  if (ticket === undefined) return { why: `devices answered ${String(issued.status)}: ${issued.text.slice(0, 200)}` };
  // As `kinu connect --join` sends it (device protocol 5): the machine's public key beside the ticket.
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  const joined = await call(account, '/pc/join', { method: 'POST', body: JSON.stringify({ ticket, publicKey, label: MACHINE_LABEL }) });
  const device = joined.status === 201 ? /"deviceId":"([^"]+)"/u.exec(joined.text)?.[1] : undefined;

  return device === undefined ? { why: `join answered ${String(joined.status)}: ${joined.text.slice(0, 200)}` } : { device, why: '' };
}

async function machineListed(account: Account, device: string): Promise<Verdict> {
  const devices = await call(account, '/api/user/devices');

  return ['the machine joined to the workspace is listed', devices.status === 200 && devices.text.includes(device), `devices answered ${String(devices.status)} without ${device}`];
}

const DevicesSchema = v.array(v.looseObject({ id: v.string(), label: v.string() }));

/** Every machine this row joined to the fixture account but `keep`. */
async function removeMachinesBut(account: Account, keep: string | undefined): Promise<void> {
  const listed = await call(account, '/api/user/devices');

  for (const device of v.parse(DevicesSchema, JSON.parse(listed.text)).filter((each) => each.label === MACHINE_LABEL && each.id !== keep)) {
    await removeMachine(account, device.id);
  }
}

async function removeMachine(account: Account, device: string): Promise<void> {
  await call(account, `/api/user/devices/${encodeURIComponent(device)}`, { method: 'DELETE' });
}

// ── Check, then seed ─────────────────────────────────────────────────────────

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
  readonly identity: PublicWebIdentity;
}

function evalAccounts(origin: string): EvalAccounts {
  const resolved = resolveWebIdentity(origin, { ...process.env, KINU_EVAL_ACCOUNT: undefined });

  if (resolved.kind !== 'ready') throw new Error(resolved.remedy);

  return {
    account: { origin, email: 'eval-service', headers: webHeaders(resolved.identity) },
    recipient: { origin, email: EVAL_RECIPIENT, headers: webHeaders({ ...resolved.identity, account: 'devices' }) },
    identity: resolved.identity,
  };
}

/** The eval identity's account from nothing, on this build: its workspace's name, and the verdicts. */
async function freshStart({ account, recipient }: EvalAccounts, stamp: string): Promise<{ workspace: string; verdicts: Verdict[] }> {
  // Not `eval-`, which the eval sweep deletes: the anchor's stays, and this row removes the rest.
  const workspace = await createWorkspace(account, `${FRESH_PREFIX}${stamp}`);
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

/** The fixtures for the next deploy, made on this build and checked as made, beside the baseline's and never over it:
 *  its file takes the path the baseline's does not. */
async function seed(fixture: Account, sender: Account, made: { stamp: string; fresh: string; previous: Manifest | null }): Promise<Seeded> {
  const workspace = await workspaceNamed(fixture, FIXTURE.workspace) ?? await createWorkspace(fixture, FIXTURE.workspace);
  const senderWorkspace = await workspaceNamed(sender, SENDER.workspace) ?? await createWorkspace(sender, SENDER.workspace);
  const note = { path: NOTE_PATHS.find((path) => path !== made.previous?.note.path) ?? NOTE_PATHS[0], text: `written by the deploy of ${made.stamp}\n` };
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

  return { manifest, verdicts };
}

const SharedSchema = v.object({ mine: v.array(v.looseObject({ id: v.string(), kind: v.string(), slate: v.optional(v.string()), workspace: v.string() })) });

/** Everything this row made that `kept` does not name, removed by name: the sender's live shares of its slate, the
 *  fixture account's machines, and the eval account's fresh workspaces. */
async function sweep(accounts: { fixture: Account; sender: Account; evals: EvalAccounts }, kept: Manifest | null): Promise<void> {
  const { fixture, sender, evals } = accounts;
  const shared = v.parse(SharedSchema, JSON.parse((await call(sender, '/api/shared')).text));

  for (const share of shared.mine.filter((row) => row.kind === 'live' && row.slate === SLATE && row.id !== kept?.share)) {
    await call(sender, '/api/shared/revoke', { method: 'POST', body: JSON.stringify({ workspace: share.workspace, share: share.id }) });
  }

  await removeMachinesBut(fixture, kept?.device);
  await sweepFresh(evals, kept?.fresh);
}

/** The eval identity's fresh-start workspaces but `kept`. */
async function sweepFresh(evals: EvalAccounts, kept: string | undefined): Promise<void> {
  const { origin } = evals.account;

  for (const row of await listWorkspaces(origin, evals.identity)) {
    if (row.name.startsWith(FRESH_PREFIX) && row.name !== kept) await deleteWorkspace(origin, evals.identity, row.name);
  }
}

function printed(title: string, verdicts: readonly Verdict[]): boolean {
  for (const [what, held, detail] of verdicts) console.log(`${title}: ${held ? 'ok  ' : 'MISS'} ${what}${held ? '' : ` (${detail})`}`);

  return verdicts.every(([, held]) => held);
}

/** A seed as made, and whether each of it held. */
interface Seeded {
  readonly manifest: Manifest;
  readonly verdicts: Verdict[];
}

/** What one deploy's run reads and writes: the deployment's, or a test's. */
export interface FixtureRun {
  /** What the last completed seed left, read from the releases bucket; null where none is. */
  readonly anchor: () => Promise<Manifest | null>;
  /** When staging was last reset (`resets/latest.json`), or null where it never was: a full reset deletes the anchor and
   *  every builtin account with it. */
  readonly resetAt: () => Promise<string | null>;
  /** Why the two builtin accounts cannot sign in, or null when both can. */
  readonly accountsMissing: () => Promise<string | null>;
  readonly continuity: (expected: Manifest) => Promise<Verdict[]>;
  readonly freshStart: () => Promise<{ workspace: string; verdicts: Verdict[] }>;
  readonly seed: (made: { fresh: string; previous: Manifest | null }) => Promise<Seeded>;
  readonly writeAnchor: (manifest: Manifest) => Promise<void>;
  /** Everything a run of this row made that `kept` (the anchor, when there is one) does not name, removed by name: the
   *  baseline an anchor replaced, a seed that did not hold, and what any run that stopped part way left. */
  readonly sweep: (kept: Manifest | null) => Promise<void>;
  /** The eval identity's fresh-start workspaces but `kept`: the eval side of the sweep, which needs no builtin account. */
  readonly sweepFresh: (kept: string) => Promise<void>;
}

/**
 * The previous seed checked against the anchor; on any miss, red, and nothing more. Then a fresh start, and the next
 * seed, which becomes the anchor only once every part of it held; then everything the anchor does not name is swept.
 * A seed that did not hold is swept, and the anchor stays as it was.
 */
export async function runFixtures(
  run: FixtureRun,
  report: (title: string, verdicts: readonly Verdict[]) => boolean = printed,
  notice: (said: string) => void = rowNotice,
): Promise<boolean> {
  const previous = await run.anchor();

  if (previous === null) {
    const missing = await run.accountsMissing();
    const reset = missing === null ? null : await run.resetAt();

    // A reset deletes the anchor and the accounts together, and leaves no older build's data: nothing to upgrade, and
    // nothing to seed with until the owner, who alone can invite, makes the accounts again. The fresh start is on the eval
    // identity, which a reset does not take away, and this build is still held to it.
    if (missing !== null && reset === null) throw new Error(missing);

    if (reset !== null) {
      notice(`staging was reset at ${reset}: no older build's data is left to upgrade, and the reset deleted ${FIXTURE.email} and `
        + `${SENDER.email} (${String(missing)}), so continuity and the seed are skipped. They resume on the deploy after the `
        + `deployment's owner invites both again, with the passwords ${FIXTURE_PASSWORD_ENV} and ${SENDER_PASSWORD_ENV} hold.`);
      const fresh = await run.freshStart();
      const started = report('a fresh start on the eval account', fresh.verdicts);

      await run.sweepFresh(fresh.workspace);

      return started;
    }

    report('continuity: no anchor, so this deploy seeds the first', []);
  }
  else if (!report(`continuity of the seed of ${previous.seededAt}`, await run.continuity(previous))) return false;
  const fresh = await run.freshStart();
  const started = report('a fresh start on the eval account', fresh.verdicts);
  const next = await run.seed({ fresh: fresh.workspace, previous });

  if (!report('the seed for the next deploy', next.verdicts)) {
    await run.sweep(previous);

    return false;
  }

  await run.writeAnchor(next.manifest);
  await run.sweep(next.manifest);

  return started;
}

/** The deployment's run: two builtin accounts, the eval identity's, and the releases bucket's anchor. */
async function deploymentRun(origin: string): Promise<FixtureRun> {
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/gu, '').toLowerCase();
  // Signed in once, when first needed: after a reset the accounts are gone, and the run says so rather than failing here.
  let signing: Promise<readonly (Account | { readonly refused: string })[]> | undefined;
  const signIns = () => (signing ??= Promise.all([signedIn(origin, FIXTURE.email, FIXTURE_PASSWORD_ENV), signedIn(origin, SENDER.email, SENDER_PASSWORD_ENV)]));

  const accounts = async (): Promise<{ fixture: Account; sender: Account }> => {
    const [fixture, sender] = await signIns();

    if (fixture === undefined || 'refused' in fixture) throw new Error(fixture?.refused ?? 'the fixture account was never signed in');

    if (sender === undefined || 'refused' in sender) throw new Error(sender?.refused ?? 'the sender account was never signed in');

    return { fixture, sender };
  };

  const evals = evalAccounts(origin);
  const bucket = bucketOf(deployedConfig('staging'), 'RELEASES_BUCKET');

  if (bucket === undefined) throw new Error('staging binds no RELEASES_BUCKET, where the upgrade fixtures keep their anchor');
  const anchored = { accountId: requireCloudflareAccountId(), bucket, key: UPGRADE_ANCHOR_KEY };

  return {
    anchor: async () => {
      const text = await r2ObjectText(anchored);

      return text === undefined ? null : v.parse(ManifestSchema, JSON.parse(text));
    },
    resetAt: async () => {
      const text = await r2ObjectText({ ...anchored, key: LATEST_RESET_KEY });

      return text === undefined ? null : v.parse(ResetSchema, JSON.parse(text)).at;
    },
    accountsMissing: async () => (await signIns()).flatMap((each) => ('refused' in each ? [each.refused] : [])).join('; ') || null,
    continuity: async (expected) => continuity((await accounts()).fixture, expected),
    freshStart: () => freshStart(evals, stamp),
    seed: async (made) => {
      const { fixture, sender } = await accounts();

      return seed(fixture, sender, { stamp, ...made });
    },
    writeAnchor: (manifest) => r2PutJson({ ...anchored, value: manifest }),
    sweep: async (kept) => { await sweep({ ...await accounts(), evals }, kept); },
    sweepFresh: async (kept) => { await sweepFresh(evals, kept); },
  };
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

  process.exit(await runFixtures(await deploymentRun(target.origin)) ? 0 : 1);
}
