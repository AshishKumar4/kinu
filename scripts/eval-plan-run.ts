#!/usr/bin/env bun
/**
 * Measure the fast models a plan login gives, against Muse, on staging (the owner's call, 2026-10-19): Claude Haiku 5.5
 * on a Claude plan and GPT-6 Luna on a ChatGPT plan, one trial of each task, each model's tasks in one account in
 * turn (EvalMatrix.sequence). The owner signs in to each plan once; nothing of it is written to disk.
 *
 *   bun scripts/eval-plan-run.ts             start the sign-in: prints the two addresses to sign in at, and returns
 *   bun scripts/eval-plan-run.ts '<address>' the address the browser ended on, when it could not reach this PC itself
 *   bun scripts/eval-plan-run.ts --dry-run   everything up to the sign-in, then stop
 *
 * The run itself is a holder this command starts (systemd unit kinu-eval-plan-run). It listens where each sign-in
 * returns (Kinu's own redirects: localhost:54545 for Claude, 127.0.0.1:1455 for ChatGPT), and reads a pasted address
 * through a FIFO, which keeps nothing. It exchanges each code for a grant and gives that grant once to the one trial
 * account its model's sequence runs in (scripts/eval-provider-keys.ts), whose object single-flights every renewal; it
 * keeps no copy it uses. At the end, or on a stop, every staging eval account's copy is deleted, ChatGPT's revoked.
 */
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  accountCredentialKey, CHATGPT_CRED_KEY, CHATGPT_PASTE_REDIRECT, chatgptHostId, CLAUDE_CRED_KEY, CLAUDE_OAUTH_CALLBACK_PORT, claudeCodeFrom,
  createClaudeOAuthClient, DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, EVAL_TRIAL_ACCOUNTS, finishChatGptPasteSignIn, startChatGptPasteSignIn,
  startClaudeSignIn, type OAuthCredential,
} from '@kinu.run/core';
import { DEFAULT_MODELS } from '../evals/src/config';
import { deployedBuild } from '../evals/src/target';
import { kinuArmada, keysWindows } from './evals-lease';
import { deploymentOf } from './infra-manifest';
import { REPO_ROOT as ROOT } from './repo-root';
import { renderThrownChain } from '@kinu.run/core/obs';

/** Where the holder keeps its FIFO, its status (what it says, never a grant) and its run's work. */
const STATE = '/mnt/local/kinu/tmp/eval-plan-run';

const FIFO = join(STATE, 'returned.fifo');

const STATUS = join(STATE, 'status.json');

const UNIT = 'kinu-eval-plan-run';

/** The ChatGPT login is a named account, so it never meets a ChatGPT login an eval account already holds. */
const CHATGPT_KEY = accountCredentialKey(CHATGPT_CRED_KEY, 'compare');

/** The models compared: Muse, the reference (DEFAULT_MODELS[0]), and each plan's fast-tier pick, on its plan's login. */
const MODELS = [
  { slug: 'muse', model: DEFAULT_MODELS[0], key: null },
  { slug: 'haiku', model: 'claude/claude-haiku-5-5', key: CLAUDE_CRED_KEY },
  { slug: 'luna', model: 'chatgpt@compare/gpt-6-luna', key: CHATGPT_KEY },
] as const;

/** The widest task's model-call peak (coding, swarm): the fewest calls at once a sequence can keep to. */
const CALLS_AT_ONCE = 6;

const StatusSchema = v.looseObject({ phase: v.string(), said: v.array(v.string()) });

/** What the holder says, a line at a time, for the starting command to print. No grant or code is ever in it. */
function say(phase: string, line: string): void {
  const said = existsSync(STATUS) ? v.parse(StatusSchema, JSON.parse(readFileSync(STATUS, 'utf8'))).said : [];

  writeFileSync(STATUS, `${JSON.stringify({ phase, said: [...said, line] }, null, 2)}\n`);
  console.log(`eval-plan-run: ${line}`);
}

/** Which plan a returned address is for: ChatGPT's comes back to its paste redirect, Claude's to its own callback. */
export function planOf(returned: string): 'claude' | 'chatgpt' {
  return returned.trim().startsWith(CHATGPT_PASTE_REDIRECT) ? 'chatgpt' : 'claude';
}

/** The staging eval accounts' copies of a plan login: read, or (`clear`) deleted, ChatGPT's revoked at OpenAI with the
 *  account's own tokens. */
export async function planLogins(origin: string, secret: string, accounts: readonly string[], clear: boolean): Promise<string[]> {
  const cleared: string[] = [];

  for (let at = 0; at < accounts.length; at += 8) {
    cleared.push(...(await Promise.all(accounts.slice(at, at + 8).map(async (account) => {
      const headers = { [DEV_IDENTITY_HEADER]: secret, ...account !== 'eval-service' && { [DEV_IDENTITY_ACCOUNT_HEADER]: account } };
      const held = v.parse(v.array(v.object({ key: v.string() })), await (await fetch(`${origin}/api/user/credentials`, { headers })).json());
      const plans = held.map(({ key }) => key).filter((key) => key === CLAUDE_CRED_KEY || key === CHATGPT_KEY);

      for (const key of clear ? plans : []) {
        const gone = await fetch(`${origin}/api/user/credentials/${encodeURIComponent(key)}?revoke=${key === CHATGPT_KEY ? '1' : '0'}`, { method: 'DELETE', headers });

        if (!gone.ok) throw new Error(`deleting ${key} from ${account} answered ${String(gone.status)}`);
      }

      return plans.map((key) => `${account} ${key}`);
    }))).flat());
  }

  return cleared;
}

/** Every eval account a run on staging can act as: eval-service and the lower half of the trial accounts. */
function stagingAccounts(): string[] {
  return ['eval-service', ...Array.from({ length: EVAL_TRIAL_ACCOUNTS / 2 }, (_, at) => `trial-${String(at + 1)}`)];
}

/** Starts the holder, or tells it a returned address; prints what it says. */
async function command(argv: readonly string[]): Promise<number> {
  const returned = argv.find((word) => !word.startsWith('--'));

  if (returned !== undefined) {
    let fifo: number;

    try {
      fifo = openSync(FIFO, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch {
      console.error('eval-plan-run: no sign-in is waiting; start it with: bun scripts/eval-plan-run.ts');

      return 1;
    }

    writeSync(fifo, `${returned.trim()}\n`);
    closeSync(fifo);
    await Bun.sleep(5000);
  } else {
    const active = Bun.spawnSync(['systemctl', '--user', 'is-active', '--quiet', UNIT]).exitCode === 0;

    if (!active) {
      mkdirSync(STATE, { recursive: true });
      rmSync(STATUS, { force: true });
      const holder = ['bun', join(ROOT, 'scripts/eval-plan-run.ts'), '--hold', ...argv.filter((word) => word === '--dry-run')];

      const started = Bun.spawnSync(['systemd-run', '--user', `--unit=${UNIT}`, '--collect', `--working-directory=${ROOT}`, `--setenv=HOME=${process.env['HOME'] ?? ''}`,
        `--setenv=PATH=${process.env['PATH'] ?? ''}`, '--setenv=TMPDIR=/mnt/local/kinu/tmp', 'bash', '-c',
        `set -a; . "$HOME/.config/kinu/secrets.env"; set +a; exec ${holder.join(' ')} > ${join(STATE, 'holder.log')} 2>&1`]);

      if (started.exitCode !== 0) throw new Error(`the holder did not start: ${started.stderr.toString()}`);
    }

    // Until the holder has something to say: the addresses, a dry run's end, or why it stopped.
    for (let at = 0; at < 120 && !existsSync(STATUS); at += 1) await Bun.sleep(500);

    for (let at = 0; at < 120 && v.parse(StatusSchema, JSON.parse(readFileSync(STATUS, 'utf8'))).phase === 'preflight'; at += 1) await Bun.sleep(500);
  }

  const status = existsSync(STATUS) ? v.parse(StatusSchema, JSON.parse(readFileSync(STATUS, 'utf8'))) : { phase: 'unknown', said: ['the holder said nothing'] };

  for (const line of status.said) console.log(line);

  return status.phase === 'failed' ? 1 : 0;
}

/** The holder: preflight, the two sign-ins, the three sequences, and the cleanup however it ends. */
async function hold(dryRun: boolean): Promise<number> {
  const origin = deploymentOf('staging').origin;
  const secret = process.env['KINU_EVAL_STAGING_WEB_IDENTITY'] ?? '';
  const out = join(STATE, `run-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
  const children: Bun.Subprocess[] = [];

  if (secret === '') throw new Error('KINU_EVAL_STAGING_WEB_IDENTITY is not set');
  const { sha } = await deployedBuild({ origin });

  say('preflight', `staging serves ${sha}; the run measures ${MODELS.map((each) => each.model).join(', ')}, one trial of each task, each model's tasks in turn in one account, at most ${String(CALLS_AT_ONCE)} calls at once.`);
  await keysWindows((line) => { say('preflight', line); });

  const claude = await startClaudeSignIn();
  const chatgpt = await startChatGptPasteSignIn({ hostId: await chatgptHostId('kinu eval plan run'), registration: null, consent: false });

  if (dryRun) {
    const held = await planLogins(origin, secret, stagingAccounts(), false);

    for (const port of [CLAUDE_OAUTH_CALLBACK_PORT, Number(new URL(CHATGPT_PASTE_REDIRECT).port)]) await Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() }).stop(true);
    say('dry-run', `dry run: both sign-ins start (Claude at ${new URL(claude.url).origin}, ChatGPT at ${new URL(chatgpt.url).origin}) and both callback ports are free; nothing listens and no code is read, so do not sign in.`);
    say('dry-run', `dry run: ${String(stagingAccounts().length)} staging eval accounts read, ${held.length === 0 ? 'none holding' : held.join(', ')} a plan login.`);
    say('dry-run', `dry run: the run would be, per model: bun scripts/evals-map.ts --staging-only --sequence --trials=1 --calls-at-once=${String(CALLS_AT_ONCE)} --out=${out}/<model>`);

    return 0;
  }

  const grants: Partial<Record<'claude' | 'chatgpt', OAuthCredential>> = {};
  let finish = (): void => {};

  const signedIn = new Promise<void>((resolve) => { finish = resolve; });

  const take = async (plan: 'claude' | 'chatgpt', returned: string): Promise<void> => {
    if (grants[plan] !== undefined) return;

    try {
      if (plan === 'claude') {
        grants.claude = await createClaudeOAuthClient().exchange(claude, claudeCodeFrom(returned, claude.state));
      } else {
        const answered = await finishChatGptPasteSignIn(chatgpt.held, returned);

        if (answered.outcome !== 'signed_in') throw new Error(`ChatGPT answered ${answered.outcome}`);
        grants.chatgpt = answered.credential;
      }

      say('signing-in', `${plan === 'claude' ? 'Claude' : 'ChatGPT'}: signed in.`);
    } catch (error) {
      say('signing-in', `${plan === 'claude' ? 'Claude' : 'ChatGPT'}: that sign-in did not take (${error instanceof Error ? error.message : String(error)}); sign in at its address again.`);
    }

    if (grants.claude !== undefined && grants.chatgpt !== undefined) finish();
  };

  // Each plan's own return: the callback path on its port, and nothing else the browser asks there (its icon).
  const callback = (plan: 'claude' | 'chatgpt', path: string) => async (request: Request) => {
    if (new URL(request.url).pathname !== path) return new Response('', { status: 404 });
    await take(plan, request.url);

    return new Response('<p>Kinu has the sign-in. You can close this tab.</p>', { headers: { 'content-type': 'text/html' } });
  };

  const servers = [
    Bun.serve({ hostname: '127.0.0.1', port: CLAUDE_OAUTH_CALLBACK_PORT, fetch: callback('claude', '/callback') }),
    Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(CHATGPT_PASTE_REDIRECT).port), fetch: callback('chatgpt', new URL(CHATGPT_PASTE_REDIRECT).pathname) }),
  ];

  rmSync(FIFO, { force: true });

  if (Bun.spawnSync(['mkfifo', '-m', '600', FIFO]).exitCode !== 0) throw new Error(`could not make ${FIFO}`);

  // A pasted address, a writer at a time; it reads until the run is signed in, and the FIFO goes with the holder.
  const reading = (async () => {
    while (grants.claude === undefined || grants.chatgpt === undefined) {
      for (const line of (await Bun.file(FIFO).text()).split('\n')) if (line.trim() !== '') await take(planOf(line), line);
    }
  })();

  const stop = async (why: string): Promise<void> => {
    for (const child of children) child.kill();

    for (const slug of MODELS.map((each) => each.slug)) {
      const run = join(out, slug, 'run.json');

      if (existsSync(run)) for (const job of v.parse(v.looseObject({ jobs: v.array(v.string()) }), JSON.parse(readFileSync(run, 'utf8'))).jobs) await kinuArmada().cancel(job);
    }

    say('stopping', why);
  };

  process.on('SIGTERM', () => {
    stop('stopped by SIGTERM').then(() => process.exit(1), () => process.exit(1));
  });

  try {
    // A copy an earlier run left would be kept as the account's own (eval-provider-keys gives a grant once).
    const stale = await planLogins(origin, secret, stagingAccounts(), true);

    if (stale.length > 0) say('signing-in', `cleared what an earlier run left: ${stale.join(', ')}`);
    say('signing-in', `Sign in to Claude: ${claude.url}`);
    say('signing-in', `Sign in to ChatGPT: ${chatgpt.url}`);
    say('signing-in', 'Each returns to this PC by itself. If a browser elsewhere cannot reach it, paste the address it ended on: bun scripts/eval-plan-run.ts \'<address>\'');
    await Promise.race([signedIn, reading]);

    for (const server of servers) await server.stop(true);
    mkdirSync(out, { recursive: true });
    say('running', `both plans signed in; the three sequences start, their work under ${out}`);

    for (const { slug, model, key } of MODELS) {
      const grant = key === null ? undefined : grants[key === CLAUDE_CRED_KEY ? 'claude' : 'chatgpt'];

      children.push(Bun.spawn(['bun', 'scripts/evals-map.ts', '--staging-only', '--sequence', '--trials=1', `--calls-at-once=${String(CALLS_AT_ONCE)}`, `--out=${join(out, slug)}`], {
        cwd: ROOT,
        env: { ...process.env, KINU_EVAL_MODELS: model, ...key !== null && grant !== undefined && { KINU_EVAL_PLAN_GRANTS: JSON.stringify({ [key]: grant }) } },
        stdout: Bun.file(join(out, `${slug}.log`)), stderr: Bun.file(join(out, `${slug}.err`)),
      }));
    }

    // The accounts own the grants from here; this process keeps no copy it uses.
    delete grants.claude;
    delete grants.chatgpt;
    const exits = await Promise.all(children.map(async (child) => await child.exited));

    say('cleaning', `the sequences ended: ${MODELS.map((each, at) => `${each.slug} ${String(exits[at])}`).join(', ')}`);

    return exits.every((exit) => exit === 0) ? 0 : 1;
  } catch (error) {
    await stop(error instanceof Error ? error.message : String(error));

    return 1;
  } finally {
    for (const server of servers) await server.stop(true);
    rmSync(FIFO, { force: true });
    const cleared = await planLogins(origin, secret, stagingAccounts(), true);

    say('done', `cleared every plan login: ${cleared.length === 0 ? 'none was held' : cleared.join(', ')}`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let code: number;

  try {
    code = argv.includes('--hold') ? await hold(argv.includes('--dry-run')) : await command(argv);
  } catch (error) {
    say('failed', `stopped: ${renderThrownChain({ cause: error })}`);
    code = 1;
  }

  process.exitCode = code;
}
