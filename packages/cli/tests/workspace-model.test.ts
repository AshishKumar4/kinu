/**
 * The model a local workspace's turns run on, read where it lands: the model each request names at the endpoint,
 * and the conversation those turns continue, read where a reopened workspace shows it.
 * The profile's default tier is the one default: a first provider connect names it, a later one leaves it, the home
 * screen's Defaults change it, and an unpinned workspace runs it. A model or effort chosen for one workspace (the TUI
 * picker, `/model`, `/effort`, `kinu model`, `kinu effort`, the rpc `model` command) is that workspace's alone and
 * survives a restart. An OpenAI-compatible endpoint with no model named serves its first listed. Every child runs
 * behind the fixture's refusing proxy: only the loopback endpoint answers.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { runToExit, scratchDir } from '@kinu.run/test-utils';

import { runTuiInPty, type PtyStep } from './helpers/pty-screen';

const cliBin = resolve(import.meta.dir, '../bin/cli.ts');

const repoRoot = resolve(import.meta.dir, '../../..');

const endpointFixture = resolve(import.meta.dir, 'fixtures/mock-llm-server.ts');

/** Credentials a developer shell may export; any of them would outrank the endpoint under test. */
const NO_AMBIENT_PROVIDER = { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', CODEX_ACCESS_TOKEN: '' };

const REPLY = 'fixture-reply-7c1d';

const RequestLineSchema = v.object({ model: v.optional(v.string()), stream: v.boolean() });

interface Endpoint {
  readonly baseURL: string;
  readonly proxy: string;
  readonly log: string;
  /** `opened` / `aborted` per request under the endpoint's never-answering `/blackhole/`. */
  readonly blackholeLog: string;
  readonly stop: () => void;
}

/** A KINU_HOME and the one endpoint it can reach. */
interface Machine {
  readonly home: string;
  readonly endpoint: Endpoint;
  readonly env?: Readonly<Record<string, string>>;
}

const running: Endpoint[] = [];

afterEach(() => {
  for (const endpoint of running.splice(0)) endpoint.stop();
});

async function startEndpoint(models: readonly string[], refuse: readonly string[] = []): Promise<Endpoint> {
  const logs = scratchDir('workspace-model-requests');
  const log = join(logs, 'requests.jsonl');
  const blackholeLog = join(logs, 'blackhole.log');
  writeFileSync(log, '');
  writeFileSync(blackholeLog, '');

  const proc = Bun.spawn([process.execPath, endpointFixture], {
    env: {
      ...process.env,
      MOCK_LLM_MODELS: models.join(','),
      MOCK_LLM_REQUEST_LOG: log,
      MOCK_LLM_BLACKHOLE_LOG: blackholeLog,
      MOCK_LLM_ANSWER: REPLY,
      MOCK_LLM_REFUSE: refuse.join(','),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let banner = '';

  for await (const chunk of proc.stdout) {
    banner += new TextDecoder().decode(chunk);

    if (banner.includes('\n')) break;
  }

  const ports = v.parse(v.object({ model: v.number(), proxy: v.number() }), JSON.parse(/^READY (.+)$/m.exec(banner)?.[1] ?? 'null'));

  const endpoint = {
    baseURL: `http://127.0.0.1:${String(ports.model)}/v1`,
    proxy: `http://127.0.0.1:${String(ports.proxy)}`,
    log,
    blackholeLog,
    stop: () => { proc.kill(); },
  };

  running.push(endpoint);

  return endpoint;
}

/** The endpoint connected and no model named: its first listed becomes the default when one is needed. */
async function connectedMachine(): Promise<Machine> {
  const endpoint = await startEndpoint(['alpha-model', 'beta-model']);
  const home = scratchDir('workspace-model-home');

  writeFileSync(join(home, 'config.json'), `${JSON.stringify({
    providers: { openaiCompat: { default: { baseURL: endpoint.baseURL, apiKey: 'mock' } } },
  })}\n`, { mode: 0o600 });

  return { home, endpoint };
}

function cliEnv({ home, endpoint, env }: Machine) {
  return {
    ...NO_AMBIENT_PROVIDER,
    KINU_HOME: home,
    KINU_SKIP_DAEMON: '1',
    KINU_UPDATE_CHECK: '0',
    HTTP_PROXY: endpoint.proxy,
    HTTPS_PROXY: endpoint.proxy,
    http_proxy: endpoint.proxy,
    https_proxy: endpoint.proxy,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    ...env,
  };
}

async function mustRun(machine: Machine, args: readonly string[], stdin?: string): Promise<string> {
  const run = await runToExit([process.execPath, cliBin, ...args], {
    cwd: scratchDir('workspace-model-cwd'),
    env: { ...process.env, ...cliEnv(machine) },
    stdin,
  });

  expect(run.exitCode, `kinu ${args.join(' ')}\n${run.stdout}\n${run.stderr}`).toBe(0);

  return run.stdout;
}

/** A TUI ends when its terminal closes; a command that finishes on its own is only waited for. */
async function inTerminal(machine: Machine, args: readonly string[], steps: readonly PtyStep[], close = true): Promise<void> {
  const run = await runTuiInPty(cliBin, {
    args: [...args],
    cwd: scratchDir('workspace-model-tui'),
    cols: 120,
    rows: 32,
    env: cliEnv(machine),
    steps: [...steps, ...(close ? [{ signal: 'SIGHUP' } as const] : []), { sleep: 10 }],
  });

  expect(run.waits.every((wait) => wait.met), run.screen).toBe(true);
  expect(run.exited, run.screen).toBe(true);
}

/** Every model the endpoint was asked for, oldest first; `turns` keeps the streamed chat turns only. */
function requestedModels({ endpoint }: Machine, turns: boolean): string[] {
  return readFileSync(endpoint.log, 'utf8').split('\n').filter(Boolean)
    .map((line) => v.parse(RequestLineSchema, JSON.parse(line)))
    .filter((request) => !turns || request.stream)
    .map((request) => request.model ?? '(none)');
}

/** Runs one turn in the workspace and answers the model it ran on. */
async function nextTurnModel(machine: Machine, workspace: string): Promise<string | undefined> {
  const before = requestedModels(machine, true).length;
  await mustRun(machine, ['run', workspace, 'hello']);

  return requestedModels(machine, true).slice(before).at(-1);
}

const PICK_BETA: readonly PtyStep[] = [
  { send: '\u000C' },
  { wait: 'Select model', timeout: 15 },
  { send: 'beta' },
  { wait: 'beta-model', timeout: 5 },
  { send: '\r' },
];

describe('the default model', () => {
  test('an OpenAI-compatible endpoint with no model named serves the first model its /models lists', async () => {
    const machine = await connectedMachine();

    await mustRun(machine, ['create', 'first-light', '--mode', 'local']);

    expect(await nextTurnModel(machine, 'first-light')).toBe('alpha-model');
  });

  test('the first provider connect names it, a second leaves it, and a new workspace runs it', async () => {
    const machine = { home: scratchDir('workspace-model-fresh-home'), endpoint: await startEndpoint(['alpha-model', 'beta-model']) };

    await inTerminal(machine, ['provider', 'connect', 'openai-compatible', '--local'], [
      { wait: 'Base URL', timeout: 30 },
      { send: `${machine.endpoint.baseURL}\r` },
      { wait: 'API key', timeout: 10 },
      { send: 'mock\r' },
      { wait: 'Default model', timeout: 15 },
      { send: '\r' },
      { wait: 'openai-compat/alpha-model', timeout: 15 },
    ], false);
    await inTerminal(machine, ['provider', 'connect', 'openai', '--local'], [
      { wait: 'OpenAI API key', timeout: 30 },
      { send: 'sk-fixture\r' },
      { wait: 'Default model', timeout: 10 },
      { send: '\r' },
      { wait: 'stays', timeout: 15 },
    ], false);
    await mustRun(machine, ['create', 'after-connects', '--mode', 'local']);

    expect(await nextTurnModel(machine, 'after-connects')).toBe('alpha-model');
  });

  test('a /models probe that never answers waits visibly until Enter skips it, which aborts it and asks for the model', async () => {
    const machine = { home: scratchDir('workspace-model-blackhole-home'), endpoint: await startEndpoint(['alpha-model']) };
    const blackholed = machine.endpoint.baseURL.replace(/\/v1$/u, '/blackhole/v1');

    await inTerminal(machine, ['provider', 'connect', 'openai-compatible', '--local'], [
      { wait: 'Base URL', timeout: 30 },
      { send: `${blackholed}\r` },
      { wait: 'API key', timeout: 10 },
      { send: 'mock\r' },
      { wait: `Checking ${blackholed}/models… Enter skips.`, timeout: 15 },
      { sleep: 1 },
      { send: '\r' },
      { wait: 'Default model', timeout: 10 },
      { send: 'typed-model\r' },
      { wait: 'openai-compat/typed-model', timeout: 15 },
    ], false);

    expect(readFileSync(machine.endpoint.blackholeLog, 'utf8')).toBe('opened\naborted\n');
  });

  test('picked under Defaults on the home screen is the model a new workspace\'s first requests name', async () => {
    const machine = await connectedMachine();

    await inTerminal(machine, [], [
      { wait: 'What is this workspace for?', timeout: 45 },
      { send: 'Keep the fixture honest' },
      ...PICK_BETA,
      { gone: 'Select model', timeout: 10 },
      // One key per write: a burst of keys reads as a paste.
      { send: '\t' },
      { sleep: 0.3 },
      { send: '\t' },
      { sleep: 0.3 },
      { send: '\r' },
      { wait: 'Send a message', timeout: 45 },
      { send: 'hello\r' },
      { wait: REPLY, timeout: 45 },
    ]);

    expect(requestedModels(machine, true).length).toBeGreaterThan(0);
    expect(new Set(requestedModels(machine, false))).toEqual(new Set(['beta-model']));
  });
});

describe('a model or effort chosen for a workspace', () => {
  test('in the TUI picker and by /effort holds after a restart, and no other workspace moves', async () => {
    const machine = await connectedMachine();
    await mustRun(machine, ['create', 'picked', '--mode', 'local']);
    await mustRun(machine, ['create', 'untouched', '--mode', 'local']);

    await inTerminal(machine, ['chat', 'picked'], [
      { wait: 'Send a message', timeout: 45 },
      ...PICK_BETA,
      { wait: 'Model: openai-compat/beta-model', timeout: 10 },
      { send: '/effort high\r' },
      { wait: 'Reasoning effort: high', timeout: 10 },
    ]);

    expect(await nextTurnModel(machine, 'picked')).toBe('beta-model');
    expect(await nextTurnModel(machine, 'untouched')).toBe('alpha-model');
    expect(await mustRun(machine, ['effort', 'picked'])).toContain('high');
    expect(await mustRun(machine, ['effort', 'untouched'])).not.toContain('high');
  });

  test('by /model holds after a restart', async () => {
    const machine = await connectedMachine();
    await mustRun(machine, ['create', 'slashed', '--mode', 'local']);

    await inTerminal(machine, ['chat', 'slashed'], [
      { wait: 'Send a message', timeout: 45 },
      { send: '/model openai-compat/beta-model\r' },
      { wait: 'Model: openai-compat/beta-model', timeout: 10 },
    ]);

    expect(await nextTurnModel(machine, 'slashed')).toBe('beta-model');
  });

  test('with kinu model and kinu effort is that workspace\'s alone', async () => {
    const machine = await connectedMachine();
    await mustRun(machine, ['create', 'retuned', '--mode', 'local']);
    await mustRun(machine, ['create', 'bystander', '--mode', 'local']);

    await mustRun(machine, ['model', 'retuned', 'openai-compat/beta-model']);
    await mustRun(machine, ['effort', 'retuned', 'high']);

    expect(await mustRun(machine, ['model', 'retuned'])).toContain('openai-compat/beta-model');
    expect(await nextTurnModel(machine, 'retuned')).toBe('beta-model');
    expect(await nextTurnModel(machine, 'bystander')).toBe('alpha-model');
    expect(await mustRun(machine, ['effort', 'retuned'])).toContain('high');
    expect(await mustRun(machine, ['effort', 'bystander'])).not.toContain('high');
  });

  test('with kinu effort on a machine with no profile yet leaves kinu exec reaching the model the environment names', async () => {
    const endpoint = await startEndpoint(['alpha-model']);

    const machine = {
      home: scratchDir('workspace-model-env-home'),
      endpoint,
      env: { KINU_BASE_URL: endpoint.baseURL, KINU_AUTH: 'Bearer mock', KINU_MODEL: 'alpha-model' },
    };

    await mustRun(machine, ['create', 'maxed', '--mode', 'local']);

    await mustRun(machine, ['effort', 'maxed', 'max']);
    await mustRun(machine, ['exec', '-w', 'maxed', '--no-auto-evolve', 'hello']);

    expect(requestedModels(machine, true).length).toBeGreaterThan(0);
    expect(new Set(requestedModels(machine, false))).toEqual(new Set(['alpha-model']));
  });

  test('by the rpc model command holds after the session ends', async () => {
    const machine = await connectedMachine();
    await mustRun(machine, ['create', 'scripted', '--mode', 'local']);

    const rpc = await mustRun(machine, ['run', 'scripted', '--mode', 'rpc'],
      `${JSON.stringify({ id: 1, type: 'model', spec: 'openai-compat/beta-model' })}\n${JSON.stringify({ type: 'exit' })}\n`);

    expect(rpc).toContain('openai-compat/beta-model');
    expect(await nextTurnModel(machine, 'scripted')).toBe('beta-model');
  });
});

describe('a reopened workspace', () => {
  test('shows in the TUI the conversation its next turn continues', async () => {
    const machine = await connectedMachine();
    await mustRun(machine, ['create', 'resumed', '--mode', 'local']);
    await mustRun(machine, ['run', 'resumed', 'remember the fixture']);

    await inTerminal(machine, ['chat', 'resumed'], [
      { wait: 'Send a message', timeout: 45 },
      { wait: 'remember the fixture', timeout: 10 },
      { wait: REPLY, timeout: 10 },
    ]);
  });
});

/** The default tier's fallbacks, written through the profile store as the settings page's save writes a tier. */
async function setDefaultFallbacks(machine: Machine, fallbacks: readonly string[]): Promise<void> {
  const script = `
    const { loadActiveProfile } = await import('./packages/cli/src/default-model.ts');
    const { writeLocalProfile } = await import('./packages/cli/src/profiles.ts');
    const { catalog } = await loadActiveProfile();
    await writeLocalProfile({ ...catalog, tiers: { ...catalog.tiers, default: { ...catalog.tiers.default, fallbacks: ${JSON.stringify(fallbacks)} } } });
  `;

  const run = await runToExit([process.execPath, '-e', script], {
    cwd: repoRoot, env: { ...process.env, ...cliEnv(machine) },
  });

  expect(run.exitCode, run.stderr).toBe(0);
}

const TimelineRowSchema = v.looseObject({ kind: v.string(), payload: v.unknown() });

describe("a tier's fallback chain", () => {
  test('a refused model hands its turn to the fallback, and the run says which model answered and why', async () => {
    const endpoint = await startEndpoint(['alpha-model', 'beta-model'], ['alpha-model']);
    const home = scratchDir('workspace-model-fallback-home');

    writeFileSync(join(home, 'config.json'), `${JSON.stringify({
      providers: { openaiCompat: { default: { baseURL: endpoint.baseURL, apiKey: 'mock' } } },
    })}\n`, { mode: 0o600 });

    const machine = { home, endpoint };
    await mustRun(machine, ['create', 'chained', '--mode', 'local']);
    await setDefaultFallbacks(machine, ['openai-compat/beta-model']);

    const printed = await mustRun(machine, ['run', 'chained', 'hello']);

    expect(requestedModels(machine, true)).toEqual(['alpha-model', 'beta-model']);
    expect(printed).toContain(REPLY);
    expect(printed).toContain('openai-compat/beta-model took over from openai-compat/alpha-model');
    expect(printed).toContain('insufficient credits for alpha-model (HTTP 402)');

    const timeline = v.parse(v.array(TimelineRowSchema), JSON.parse(await mustRun(machine, ['timeline', 'chained', '--json'])));
    expect(timeline.find((row) => row.kind === 'run:model_fallback')?.payload)
      .toMatchObject({ from: 'openai-compat/alpha-model', to: 'openai-compat/beta-model' });
  });
});
