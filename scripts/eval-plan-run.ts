#!/usr/bin/env bun
/**
 * Measure the fast models a plan login gives, against Muse, on staging (the owner's call, 2026-10-19): Claude Haiku 5.5
 * on a Claude plan and GPT-6 Luna on a ChatGPT plan, one trial of each task, each model's tasks in one account in
 * turn (EvalMatrix.sequence). The plans' logins are the ones OMP holds on this PC (Main, 2026-10-20).
 *
 *   bun scripts/eval-plan-run.ts --models=haiku   run Muse and the named models; prints what the holder says, and returns
 *   bun scripts/eval-plan-run.ts                  the running holder's status
 *   bun scripts/eval-plan-run.ts --dry-run        everything up to the run, then stop
 *   …--without-muse                               the named models alone, with no Muse reference (the owner, 2026-10-23:
 *                                                 trajectory reviews on Claude Haiku 5.5 at low effort)
 *   …--tasks=chat-app,office --trials=2           only those tasks, that many trials each (default: every task, one)
 *   …--effort=low                                 the trial accounts' turns ask that reasoning effort (KINU_EVAL_EFFORT)
 *
 * The run is a holder this command starts (systemd unit kinu-eval-plan-run). It reads each plan's login from OMP's own
 * store, read-only and its access token alone: OMP renews its logins under its own lease, which nothing here touches,
 * and no refresh token leaves its store. The trial account a model's sequence runs in is given that access token
 * (scripts/eval-provider-keys.ts), which it uses as it is until it expires and never renews; while the run lasts, each
 * token OMP has renewed since is given again to the account that holds the old one. At the end, or on a stop, every
 * staging eval account's copy is deleted.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  accountCredentialKey, CHATGPT_CRED_KEY, CLAUDE_CRED_KEY, CODEX_CRED_KEY, DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER,
  EVAL_TRIAL_ACCOUNTS, type OAuthCredential,
} from '@kinu.run/core';
import { DEFAULT_MODELS } from '../evals/src/config';
import { deployedBuild } from '../evals/src/target';
import { kinuArmada, keysWindows } from './evals-lease';
import { deploymentOf } from './infra-manifest';
import { REPO_ROOT as ROOT } from './repo-root';
import { renderThrownChain } from '@kinu.run/core/obs';

/** Where the holder keeps its status (what it says, never a grant) and its run's work. */
const STATE = '/mnt/local/kinu/tmp/eval-plan-run';

const STATUS = join(STATE, 'status.json');

const UNIT = 'kinu-eval-plan-run';

/** A ChatGPT login an earlier run of this script left, under its named account; cleared like the others. */
const CHATGPT_KEY = accountCredentialKey(CHATGPT_CRED_KEY, 'compare');

/** OMP's store of its logins on this PC, opened read-only. */
const OMP_STORE = join(process.env['HOME'] ?? '', '.omp/agent/agent.db');

/** Each plan's login in OMP's store: its row, and the provider that row must be. */
export interface OmpLogin { readonly id: number; readonly provider: string }

/** How often the holder looks for a token OMP has renewed. */
const RENEWED_EVERY_MS = 5 * 60_000;

/** The models compared: Muse, the reference (DEFAULT_MODELS[0]), and each plan's fast-tier pick, on its plan's login in
 *  OMP's store. Luna is Codex's: OMP's ChatGPT login is the Codex CLI's, which only chatgpt.com takes, so its calls go
 *  out through a machine connected to its trial account. */
const MODELS = [
  { slug: 'muse', model: DEFAULT_MODELS[0], key: null, omp: null },
  { slug: 'haiku', model: 'claude/claude-haiku-5-5', key: CLAUDE_CRED_KEY, omp: { id: 55, provider: 'anthropic' } },
  { slug: 'luna', model: 'codex/gpt-6-luna', key: CODEX_CRED_KEY, omp: { id: 48, provider: 'openai-codex' } },
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

/**
 * A plan's login as OMP holds it now: its access token and when that ends, and nothing else of the row. The row must be
 * the provider named and in use.
 */
export function ompGrant(store: string, login: OmpLogin): OAuthCredential {
  const db = new Database(store, { readonly: true });

  try {
    const row = v.parse(v.object({ provider: v.literal(login.provider), disabled_cause: v.null(), data: v.string() }),
      db.query('SELECT provider, disabled_cause, data FROM auth_credentials WHERE id = ?').get(login.id));

    const held = v.parse(v.looseObject({ access: v.string(), expires: v.number() }), JSON.parse(row.data));

    return { kind: 'oauth', accessToken: held.access, expiresAt: held.expires };
  } finally {
    db.close();
  }
}

/** The staging eval accounts' copies of a plan login: read, or (`clear`) deleted. */
export async function planLogins(origin: string, secret: string, accounts: readonly string[], clear: boolean): Promise<string[]> {
  const cleared: string[] = [];

  // 32 at a time: a stop's clear of every staging eval account finishes well inside systemd's stop timeout.
  for (let at = 0; at < accounts.length; at += 32) {
    cleared.push(...(await Promise.all(accounts.slice(at, at + 32).map(async (account) => {
      const headers = { [DEV_IDENTITY_HEADER]: secret, ...account !== 'eval-service' && { [DEV_IDENTITY_ACCOUNT_HEADER]: account } };
      const held = v.parse(v.array(v.object({ key: v.string() })), await (await fetch(`${origin}/api/user/credentials`, { headers })).json());
      const plans = held.map(({ key }) => key).filter((key) => key === CLAUDE_CRED_KEY || key === CODEX_CRED_KEY || key === CHATGPT_KEY);

      // Only a grant of this run's own sign-in is revoked: OMP's logins are OMP's, and revoking one would end it there.
      for (const key of clear ? plans : []) {
        const gone = await fetch(`${origin}/api/user/credentials/${encodeURIComponent(key)}?revoke=${key === CHATGPT_KEY ? '1' : '0'}`, { method: 'DELETE', headers });

        if (!gone.ok) throw new Error(`deleting ${key} from ${account} answered ${String(gone.status)}`);
      }

      return plans.map((key) => `${account} ${key}`);
    }))).flat());
  }

  return cleared;
}

/** `grant` given again to each account that holds `key`, for a token OMP has renewed; the accounts it reached. */
export async function giveAgain(input: {
  readonly origin: string; readonly secret: string; readonly holders: readonly string[]; readonly key: string; readonly grant: OAuthCredential;
}): Promise<string[]> {
  const { origin, secret, key, grant } = input;
  const given: string[] = [];

  for (const holder of input.holders) {
    const [account = '', held = ''] = holder.split(' ');

    if (held !== key) continue;
    const headers = { [DEV_IDENTITY_HEADER]: secret, ...account !== 'eval-service' && { [DEV_IDENTITY_ACCOUNT_HEADER]: account }, 'content-type': 'application/json' };
    const answer = await fetch(`${origin}/api/user/credentials/${encodeURIComponent(key)}`, { method: 'POST', headers, body: JSON.stringify(grant) });

    if (!answer.ok) throw new Error(`giving ${account} the renewed ${key} answered ${String(answer.status)}`);
    given.push(account);
  }

  return given;
}

/** Every eval account a run on staging can act as: eval-service and the lower half of the trial accounts. */
function stagingAccounts(): string[] {
  return ['eval-service', ...Array.from({ length: EVAL_TRIAL_ACCOUNTS / 2 }, (_, at) => `trial-${String(at + 1)}`)];
}

/** Starts the holder, or reads the running one; prints what it says. */
async function command(argv: readonly string[]): Promise<number> {
  const active = Bun.spawnSync(['systemctl', '--user', 'is-active', '--quiet', UNIT]).exitCode === 0;
  const starting = argv.some((word) => word === '--dry-run' || word.startsWith('--models='));

  if (!active && starting) {
    mkdirSync(STATE, { recursive: true });
    rmSync(STATUS, { force: true });

    const passed = (word: string): boolean => word === '--dry-run' || word.startsWith('--models=')
      || PASSED.some((flag) => word === flag || (flag.endsWith('=') && word.startsWith(flag)));

    const holder = ['bun', join(ROOT, 'scripts/eval-plan-run.ts'), '--hold', ...argv.filter(passed)];

    // A stop waits for the holder's cleanup (a clear of every staging eval account) rather than the default 90 s.
    const started = Bun.spawnSync(['systemd-run', '--user', `--unit=${UNIT}`, '--collect', '--property=TimeoutStopSec=300', `--working-directory=${ROOT}`, `--setenv=HOME=${process.env['HOME'] ?? ''}`,
      `--setenv=PATH=${process.env['PATH'] ?? ''}`, '--setenv=TMPDIR=/mnt/local/kinu/tmp', 'bash', '-c',
      `set -a; . "$HOME/.config/kinu/secrets.env"; set +a; exec ${holder.join(' ')} > ${join(STATE, 'holder.log')} 2>&1`]);

    if (started.exitCode !== 0) throw new Error(`the holder did not start: ${started.stderr.toString()}`);

    // Until the holder has something to say: the run under way, a dry run's end, or why it stopped.
    for (let at = 0; at < 120 && !existsSync(STATUS); at += 1) await Bun.sleep(500);

    for (let at = 0; at < 120 && v.parse(StatusSchema, JSON.parse(readFileSync(STATUS, 'utf8'))).phase === 'preflight'; at += 1) await Bun.sleep(500);
  }

  const status = existsSync(STATUS) ? v.parse(StatusSchema, JSON.parse(readFileSync(STATUS, 'utf8'))) : { phase: 'unknown', said: ['no holder has run; start one with --models=<slugs>'] };

  for (const line of status.said) console.log(line);

  return status.phase === 'failed' ? 1 : 0;
}

/** Resolves after `ms`, or at once when `signal` aborts or has, leaving no timer to hold the process open. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };

    const timer = setTimeout(done, ms);

    signal.addEventListener('abort', done, { once: true });
  });
}

/** The models a run measures: Muse unless `--without-muse`, and each one named (`--models=haiku,luna`). */
export function modelsNamed(argv: readonly string[]): (typeof MODELS)[number][] {
  const named = (argv.find((word) => word.startsWith('--models='))?.slice('--models='.length) ?? '').split(',').filter((slug) => slug !== '');
  const unknown = named.filter((slug) => !MODELS.some((each) => each.slug === slug));

  if (unknown.length > 0) throw new Error(`no model is named ${unknown.join(', ')}; the models are ${MODELS.map((each) => each.slug).join(', ')}`);

  const reference = !argv.includes('--without-muse');

  return MODELS.filter((each) => (each.omp === null ? reference : named.includes(each.slug)));
}

/** The flags a run passes through, from the holder to each sequence's `evals-map`, and its effort as `KINU_EVAL_EFFORT`. */
const PASSED = ['--without-muse', '--tasks=', '--trials=', '--effort='] as const;

/** `evals-map`'s own arguments among `argv`, and the effort the trial accounts' turns ask (none: their default). */
export function trialSelection(argv: readonly string[]) {
  const valued = (flag: string): string | undefined => argv.find((word) => word.startsWith(flag))?.slice(flag.length);
  const trials = valued('--trials=') ?? '1';
  const tasks = valued('--tasks=');

  return { map: [`--trials=${trials}`, ...tasks === undefined ? [] : [`--tasks=${tasks}`]], effort: valued('--effort=') ?? null };
}

/** The holder: preflight, each plan's login from OMP, the sequences, the renewed tokens given again, and the cleanup. */
async function hold(argv: readonly string[]): Promise<number> {
  const origin = deploymentOf('staging').origin;
  const secret = process.env['KINU_EVAL_STAGING_WEB_IDENTITY'] ?? '';
  const out = join(STATE, `run-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
  const models = modelsNamed(argv);
  const selection = trialSelection(argv);
  const children: Bun.Subprocess[] = [];

  if (secret === '') throw new Error('KINU_EVAL_STAGING_WEB_IDENTITY is not set');
  const { sha } = await deployedBuild({ origin });

  say('preflight', `staging serves ${sha}; the run measures ${models.map((each) => each.model).join(', ')} (${selection.map.join(' ')}${selection.effort === null ? '' : `, effort ${selection.effort}`}), each model's tasks in turn in one account, at most ${String(CALLS_AT_ONCE)} calls at once.`);
  await keysWindows((line) => { say('preflight', line); });

  // What each plan's account is given, by its key: the token last read from OMP.
  const given = new Map(models.flatMap((each) => (each.omp === null ? [] : [[each.key, ompGrant(OMP_STORE, each.omp)] as const])));

  for (const [key, grant] of given) say('preflight', `${key}: OMP's login ends at ${new Date(grant.expiresAt ?? 0).toISOString()}.`);

  if (argv.includes('--dry-run')) {
    const held = await planLogins(origin, secret, stagingAccounts(), false);

    say('dry-run', `dry run: ${String(stagingAccounts().length)} staging eval accounts read, ${held.length === 0 ? 'none holding' : held.join(', ')} a plan login.`);
    say('dry-run', `dry run: the run would be, per model: ${selection.effort === null ? '' : `KINU_EVAL_EFFORT=${selection.effort} `}bun scripts/evals-map.ts --staging-only --sequence ${selection.map.join(' ')} --calls-at-once=${String(CALLS_AT_ONCE)} --out=${out}/<model>`);

    return 0;
  }

  const stop = async (why: string): Promise<void> => {
    for (const child of children) child.kill();
    // Gone before the logins are cleared: a sequence still provisioning could store a grant after the clear.
    await Promise.all(children.map(async (child) => await child.exited));

    for (const slug of models.map((each) => each.slug)) {
      const run = join(out, slug, 'run.json');

      if (existsSync(run)) for (const job of v.parse(v.looseObject({ jobs: v.array(v.string()) }), JSON.parse(readFileSync(run, 'utf8'))).jobs) await kinuArmada().cancel(job);
    }

    say('stopping', why);
  };

  // A stop is only asked for here: the run below ends at it, and its one cleanup runs before the process exits.
  const stopping = new AbortController();
  const requestStop = (): void => { stopping.abort(new Error('stopped by SIGTERM')); };

  process.on('SIGTERM', requestStop);

  /** Each token OMP has renewed since it was given, given again to the account that holds the old one. */
  const renew = async (): Promise<void> => {
    for (const each of models) {
      if (each.omp === null) continue;
      const now = ompGrant(OMP_STORE, each.omp);

      if (now.accessToken === given.get(each.key)?.accessToken) continue;
      const holders = await planLogins(origin, secret, stagingAccounts(), false);
      const reached = await giveAgain({ origin, secret, holders, key: each.key, grant: now });

      given.set(each.key, now);
      say('running', `${each.key}: OMP renewed its login, to ${new Date(now.expiresAt ?? 0).toISOString()}; given again to ${reached.join(', ') || 'no account yet'}.`);
    }
  };

  /** What the sequences answered when they all ended; null when `RENEWED_EVERY_MS` passed first; a stop throws. */
  const awaitEnd = async (ended: Promise<number[]>): Promise<number[] | null> => {
    const done = await Promise.race([ended, pause(RENEWED_EVERY_MS, stopping.signal).then(() => null)]);

    stopping.signal.throwIfAborted();

    return done;
  };

  try {
    // A copy an earlier run left would be kept as the account's own (eval-provider-keys gives a grant once).
    const stale = await planLogins(origin, secret, stagingAccounts(), true);

    if (stale.length > 0) say('running', `cleared what an earlier run left: ${stale.join(', ')}`);
    mkdirSync(out, { recursive: true });
    stopping.signal.throwIfAborted();
    say('running', `the sequences start, their work under ${out}`);

    for (const { slug, model, key } of models) {
      const grant = key === null ? undefined : given.get(key);

      children.push(Bun.spawn(['bun', 'scripts/evals-map.ts', '--staging-only', '--sequence', ...selection.map, `--calls-at-once=${String(CALLS_AT_ONCE)}`, `--out=${join(out, slug)}`], {
        cwd: ROOT,
        env: {
          ...process.env, KINU_EVAL_MODELS: model, ...selection.effort !== null && { KINU_EVAL_EFFORT: selection.effort },
          ...key !== null && grant !== undefined && { KINU_EVAL_PLAN_GRANTS: JSON.stringify({ [key]: grant }) },
        },
        stdout: Bun.file(join(out, `${slug}.log`)), stderr: Bun.file(join(out, `${slug}.err`)),
      }));
    }

    const ended = Promise.all(children.map(async (child) => await child.exited));
    let done = await awaitEnd(ended);

    // While the sequences run, a renewed token reaches the account using the old one before that one ends.
    while (done === null) {
      await renew();
      done = await awaitEnd(ended);
    }

    say('cleaning', `the sequences ended: ${models.map((each, at) => `${each.slug} ${String(done[at])}`).join(', ')}`);

    return done.every((exit) => exit === 0) ? 0 : 1;
  } catch (error) {
    await stop(error instanceof Error ? error.message : String(error));

    return 1;
  } finally {
    const cleared = await planLogins(origin, secret, stagingAccounts(), true);

    process.off('SIGTERM', requestStop);
    say('done', `cleared every plan login: ${cleared.length === 0 ? 'none was held' : cleared.join(', ')}`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let code: number;

  try {
    code = argv.includes('--hold') ? await hold(argv) : await command(argv);
  } catch (error) {
    say('failed', `stopped: ${renderThrownChain({ cause: error })}`);
    code = 1;
  }

  process.exitCode = code;
}
