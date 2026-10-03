/**
 * `kinu deploy`: `cloudflare` (the same run the page drives) or `local` (this machine).
 * The verifier stays local; the token pair is POSTed once over TLS to the run that spends it.
 */
import {
  CLI_DEPLOY_REDIRECT_PORT, CLI_DEPLOY_REDIRECT_URI, CLOUDFLARE_DEPLOY_SCOPES,
  DeployFrameSchema,
  authorizeUrl, deployDoor, deployOptions, exchangeDeployCode, mintRun,
  type DeployDoor, type DeployInputs, type DeploySnapshot, type DeployStepRow,
} from '@kinu.run/core/deploy';
import { createPkcePair } from '@kinu.run/core';
import * as v from 'valibot';
import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import { defaultOrigin } from '../cloud-api';
import { ACCENT, DIM, OK, WARN } from '../display';
import { ask, askSecret, requireInteractiveTerminal } from '../prompt';
import { openBrowser } from './auth';
import { localDoor } from './deploy-local';
import { awaitOAuthCallback } from './oauth-callback';

export function deployCommand(
  door: string | undefined,
  action: string | undefined,
  opts: { origin?: string; port?: string } = {},
): Promise<void> {
  return settle(Effect.gen(function* () {
    if (door === 'local') {
      yield* Effect.promise(() => localDoor(action, opts));

      return;
    }

    if (door !== 'cloudflare') {
      console.log(`${WARN('!')} Say where to deploy: ${ACCENT('kinu deploy cloudflare')} or ${ACCENT('kinu deploy local')}`);

      return;
    }

    yield* cloudflareDoor(opts);
  }));
}

function cloudflareDoor(opts: { origin?: string }): Effect.Effect<void> {
  return Effect.gen(function* () {
    requireInteractiveTerminal();
    const origin = defaultOrigin(opts);
    const options = yield* Effect.promise(() => deployOptions(origin));

    if (!options.cloudflare) {
      console.log(`${WARN('!')} ${options.reason}`);

      return;
    }

    console.log('');
    console.log(`${DIM('Installing Kinu')} ${ACCENT(options.version)} ${DIM('into your own Cloudflare account.')}`);

    const ticket = yield* Effect.promise(() => mintRun(origin));
    const door = deployDoor({ origin, runId: ticket.runId, runKey: ticket.runKey });

    yield* authorize(door, options.clientId);
    console.log(`${OK('✓')} Authorized with Cloudflare`);

    const inputs = yield* answers(door, options.prompts);
    const started = yield* Effect.promise(() => door.start(inputs));

    yield* Effect.promise(() => follow(door, origin, started));
  });
}

function authorize(door: DeployDoor, clientId: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    const pkce = yield* Effect.promise(() => createPkcePair());
    const state = crypto.randomUUID();

    const url = authorizeUrl({
      clientId,
      redirectUri: CLI_DEPLOY_REDIRECT_URI,
      state,
      challenge: pkce.challenge,
      scopes: CLOUDFLARE_DEPLOY_SCOPES,
    });

    console.log(`${DIM('Open:')} ${ACCENT(url)}`);

    const waiting = awaitOAuthCallback(CLI_DEPLOY_REDIRECT_PORT, state);

    openBrowser(url);

    const code = yield* Effect.promise(() => waiting);

    if (code === null) return yield* Effect.die(new Error(`Port ${String(CLI_DEPLOY_REDIRECT_PORT)} is in use, and Cloudflare sends the sign-in back to it. Free it and run kinu deploy again.`));

    const token = yield* Effect.promise(() => exchangeDeployCode({
      clientId, redirectUri: CLI_DEPLOY_REDIRECT_URI, code, verifier: pkce.verifier,
    }));

    yield* Effect.promise(() => door.holdToken({
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresInSeconds: token.expiresInSeconds,
    }));
  });
}

function answers(door: DeployDoor, prompts: readonly string[]): Effect.Effect<DeployInputs> {
  return Effect.gen(function* () {
    const accounts = yield* Effect.promise(() => door.accounts());
    const first = accounts[0];

    if (first === undefined) return yield* Effect.die(new Error('that Cloudflare authorization can reach no account'));

    for (const [at, account] of accounts.entries()) {
      console.log(`  ${ACCENT(String(at + 1))}. ${account.name} ${DIM(account.id)}`);
    }

    const picked = accounts.length === 1
      ? first
      : accounts[Number.parseInt(yield* Effect.promise(() => ask('Account number', '1')), 10) - 1] ?? first;

    const instanceName = yield* Effect.promise(() => ask('Instance name', 'kinu'));
    const ownerEmail = yield* Effect.promise(() => ask('Your email (the sign-in address)'));
    const zones = yield* Effect.promise(() => door.zones());
    const hostname = zones.length === 0 ? '' : yield* Effect.promise(() => ask('Hostname (blank for a workers.dev address)', ''));
    // A label boundary, not a suffix: `kinu.notexample.com` ends with `example.com`.
    const zone = zones.find((held) => hostname === held.name || hostname.endsWith(`.${held.name}`));
    const keyNames: string[] = [];

    for (const name of prompts) {
      const value = yield* Effect.promise(() => askSecret(`${name} (blank to skip)`));

      if (value === '') continue;
      yield* Effect.promise(() => door.holdProviderKey(name, value));
      keyNames.push(name);
    }

    return {
      accountId: picked.id,
      instanceName,
      address: hostname !== '' && zone !== undefined
        ? { kind: 'zone', hostname, zoneId: zone.id }
        : { kind: 'workers-dev', hostname: '', zoneId: '' },
      ownerEmail,
      accessEmails: [ownerEmail],
      providerKeyNames: keyNames,
      sandbox: false,
    };
  });
}

/** Rows print as they change rather than redraw, so scrollback stays a record. */
async function follow(door: DeployDoor, origin: string, first: DeploySnapshot): Promise<void> {
  const shown = new Map<string, string>();

  console.log('');
  report(first, shown);

  if (first.state === 'done' || first.state === 'failed') {
    printOutcome(first);

    return;
  }

  const socket = new WebSocket(door.socketUrl(), [...door.socketProtocols()]);

  await new Promise<void>((resolve) => {
    let last = first;

    socket.addEventListener('message', (event: MessageEvent) => {
      const frame = v.safeParse(DeployFrameSchema, JSON.parse(String(event.data)));

      if (!frame.success || frame.output.type !== 'deploy.snapshot') return;
      last = frame.output.snapshot;
      report(last, shown);

      if (last.state === 'done' || last.state === 'failed') {
        socket.close();
        printOutcome(last);
        resolve();
      }
    });
    socket.addEventListener('close', () => {
      if (last.state !== 'done' && last.state !== 'failed') {
        console.log(`${WARN('!')} The progress socket closed. ${DIM(`Re-attach: kinu deploy cloudflare --origin ${origin}`)}`);
      }

      resolve();
    });
  });
}

function report(snapshot: DeploySnapshot, shown: Map<string, string>): void {
  for (const row of snapshot.steps) {
    const mark = `${row.state}:${String(row.attempt)}`;

    if (shown.get(row.id) === mark) continue;
    shown.set(row.id, mark);

    if (row.state === 'pending') continue;
    console.log(line(row));
  }
}

function line(row: DeployStepRow): string {
  if (row.state === 'done') return `${OK('✓')} ${row.title}${row.detail === '' ? '' : ` ${DIM(row.detail)}`}`;

  if (row.state === 'failed') {
    return `${WARN('✗')} ${row.title}\n  ${row.failure?.detail ?? ''}`;
  }

  return `${DIM('·')} ${row.title}${row.attempt > 1 ? DIM(` (attempt ${String(row.attempt)})`) : ''}`;
}

function printOutcome(snapshot: DeploySnapshot): void {
  console.log('');

  if (snapshot.state === 'done') {
    console.log(`${OK('✓')} Your Kinu is live at ${ACCENT(`https://${snapshot.address}`)}`);
    console.log(DIM('Sign in with the email you gave: Cloudflare Access sends a one-time PIN.'));

    return;
  }

  const failed = snapshot.steps.find((row) => row.state === 'failed');

  console.log(`${WARN('!')} The run stopped at ${ACCENT(failed?.title ?? 'a step')}.`);
  console.log(DIM('Nothing after it ran. Fix what the message says and re-run the command to carry on.'));
}
