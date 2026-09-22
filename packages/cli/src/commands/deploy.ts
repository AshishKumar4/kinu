/**
 * `kinu deploy` — the two doors a terminal has: `cloudflare` (the same run as
 * the page) and `local` (this machine, `./deploy-local.ts`).
 *
 * ONE FLOW, ONE LEDGER. Nothing here re-implements a step. The command mints a
 * run on kinu.run, authorizes on a loopback redirect the way wrangler does,
 * hands the token pair to that run, answers the four questions at the
 * terminal, and then watches the run's own progress socket and prints the rows
 * the Durable Object writes. A run started here can be finished from the page
 * and the other way round.
 *
 * THE VERIFIER STAYS LOCAL and the token pair is POSTed once over TLS to the
 * run that will spend it. What kinu.run keeps afterwards is nothing: the last
 * step writes the refresh token into the new Worker and wipes the run's vault.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  CLI_DEPLOY_REDIRECT_PORT, CLI_DEPLOY_REDIRECT_URI, CLOUDFLARE_DEPLOY_SCOPES,
  DeployFrameSchema,
  authorizeUrl, createPkcePair, deployDoor, deployOptions, exchangeDeployCode, mintRun,
  type DeployDoor, type DeployInputs, type DeploySnapshot, type DeployStepRow,
} from '@kinu.run/core/deploy';
import * as v from 'valibot';
import { defaultOrigin } from '../cloud-api';
import { ACCENT, DIM, OK, WARN } from '../display';
import { ask, askSecret, requireInteractiveTerminal } from '../prompt';
import { openBrowser } from './auth';
import { localDoor } from './deploy-local';

export async function deployCommand(
  door: string | undefined,
  action: string | undefined,
  opts: { origin?: string; port?: string } = {},
): Promise<void> {
  if (door === 'local') {
    await localDoor(action, opts);

    return;
  }

  if (door !== 'cloudflare') {
    console.log(`${WARN('!')} Say where to deploy: ${ACCENT('kinu deploy cloudflare')} or ${ACCENT('kinu deploy local')}`);

    return;
  }

  await cloudflareDoor(opts);
}

async function cloudflareDoor(opts: { origin?: string }): Promise<void> {
  requireInteractiveTerminal();
  const origin = defaultOrigin(opts);
  const options = await deployOptions(origin);

  if (!options.cloudflare) {
    console.log(`${WARN('!')} ${options.reason}`);

    return;
  }

  console.log('');
  console.log(`${DIM('Installing Kinu')} ${ACCENT(options.version)} ${DIM('into your own Cloudflare account.')}`);

  const ticket = await mintRun(origin);
  const door = deployDoor({ origin, runId: ticket.runId, runKey: ticket.runKey });

  await authorize(door, options.clientId);
  console.log(`${OK('✓')} Authorized with Cloudflare`);

  const inputs = await answers(door, options.prompts);

  await follow(door, origin, await door.start(inputs));
}

/** The authorization leg: a loopback listener, the browser, and the exchange.
 *  The code never leaves this process except as a token pair. */
async function authorize(door: DeployDoor, clientId: string): Promise<void> {
  const pkce = await createPkcePair();
  const state = crypto.randomUUID();

  const url = authorizeUrl({
    clientId,
    redirectUri: CLI_DEPLOY_REDIRECT_URI,
    state,
    challenge: pkce.challenge,
    scopes: CLOUDFLARE_DEPLOY_SCOPES,
  });

  console.log(`${DIM('Open:')} ${ACCENT(url)}`);

  const waiting = awaitCode(state);

  openBrowser(url);

  const code = await waiting;

  const token = await exchangeDeployCode({
    clientId, redirectUri: CLI_DEPLOY_REDIRECT_URI, code, verifier: pkce.verifier,
  });

  await door.holdToken({
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresInSeconds: token.expiresInSeconds,
  });
}

/**
 * The redirect, caught.
 *
 * ANYTHING MAY KNOCK ON A LOOPBACK PORT. Any page open in the browser can
 * `fetch('http://localhost:8899/…')`, and a listener that closed on the first
 * request of any kind would reject an authorization the person is in the
 * middle of giving. So a request that does not carry this run's own `state`
 * gets a 404 and the listener stays up; the leg ends on the callback that
 * carries it, which is the whole job of `state`.
 *
 * `127.0.0.1` rather than every interface: the redirect is the browser on
 * this machine, and a browser resolving `localhost` to `::1` first falls back
 * to it. Binding `::` to save that fallback would put the leg on the LAN.
 */
function awaitCode(state: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', CLI_DEPLOY_REDIRECT_URI);
      const carried = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const problem = url.searchParams.get('error');

      if (carried !== state) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('This is not the authorization this terminal started.');

        return;
      }

      const good = problem === null && code !== '';

      response.writeHead(good ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(good
        ? 'Authorized. Go back to your terminal.'
        : `That authorization did not complete${problem === null ? '' : `: ${problem}`}.`);
      server.close();

      if (good) resolve(code);
      else reject(new Error(problem ?? 'that callback carried no authorization code'));
    });

    server.on('error', reject);
    server.listen(CLI_DEPLOY_REDIRECT_PORT, '127.0.0.1');
  });
}

async function answers(door: DeployDoor, prompts: readonly string[]): Promise<DeployInputs> {
  const accounts = await door.accounts();
  const first = accounts[0];

  if (first === undefined) throw new Error('that Cloudflare authorization can reach no account');

  for (const [at, account] of accounts.entries()) {
    console.log(`  ${ACCENT(String(at + 1))}. ${account.name} ${DIM(account.id)}`);
  }

  const picked = accounts.length === 1
    ? first
    : accounts[Number.parseInt(await ask('Account number', '1'), 10) - 1] ?? first;

  const instanceName = await ask('Instance name', 'kinu');
  const ownerEmail = await ask('Your email (the sign-in address)');
  const zones = await door.zones();
  const hostname = zones.length === 0 ? '' : await ask('Hostname (blank for a workers.dev address)', '');
  // A label boundary, not a suffix: `kinu.notexample.com` ends with
  // `example.com` and belongs to a different account's zone.
  const zone = zones.find((held) => hostname === held.name || hostname.endsWith(`.${held.name}`));
  const keyNames: string[] = [];

  for (const name of prompts) {
    const value = await askSecret(`${name} (blank to skip)`);

    if (value === '') continue;
    await door.holdProviderKey(name, value);
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
}

/**
 * The run, watched on its own socket.
 *
 * The rows are printed as they change rather than redrawn: a terminal that
 * scrolled away is still a record of what happened, and the snapshot the
 * socket carries is the same one the page renders.
 */
async function follow(door: DeployDoor, origin: string, first: DeploySnapshot): Promise<void> {
  const shown = new Map<string, string>();

  console.log('');
  report(first, shown);

  if (first.state === 'done' || first.state === 'failed') {
    settle(first);

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
        settle(last);
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

function settle(snapshot: DeploySnapshot): void {
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
