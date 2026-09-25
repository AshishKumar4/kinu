import { runToExit } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { readFileSync, writeFileSync } from 'node:fs';

import { delimiter, join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseJsonObject, type JsonObject } from '@kinu.run/core';
import * as v from 'valibot';

const repoRoot = resolve(__dirname, '../../..');

/** A controlled PATH keeps a real `opencode` on this machine out of the listing. */
function runProviders(args: string[], opts: { home: string; env?: Record<string, string> }) {
  const path = ['/usr/bin', '/bin'].join(delimiter);
  const argv = JSON.stringify(args);

  const runner = `
    const { providersCommand } = await import('./packages/cli/src/commands/providers.ts');
    await providersCommand(${argv}[0], ${argv}[1], ${argv}[2], {});
  `;

  return runToExit([process.execPath, '-e', runner], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', CODEX_ACCESS_TOKEN: '',
      KINU_BASE_URL: '', KINU_AUTH: '', KINU_MODEL: '',
      PATH: path, KINU_HOME: opts.home, NO_COLOR: '1',
      ...opts.env,
    },
  });
}

function freshHome(): string {
  const home = scratchDir('providers-home');

  return home;
}

/** The default model, set the way the home screen's Defaults set it. */
async function withDefaultModel(home: string, model: string): Promise<void> {
  const proc = await runToExit([process.execPath, '-e', `
      const { updateDefaultTier } = await import('./packages/cli/src/default-model.ts');
      await updateDefaultTier({ model: ${JSON.stringify(model)} });
    `], {
    cwd: repoRoot,
    env: { ...process.env, KINU_HOME: home },
  });

  expect(proc.exitCode, proc.stderr).toBe(0);
}

describe('providers command — Claude subscription', () => {
  /** The token endpoint answers inside the child; the person pastes what Claude showed them. */
  async function connectClaude(home: string, account: string) {
    const runner = `
      const { connectProvider } = await import('./packages/cli/src/commands/provider-connect.ts');
      const sent = [];
      globalThis.fetch = async (input, init) => {
        sent.push([String(input), JSON.parse(init.body)]);
        return Response.json({
          access_token: 'sk-ant-oat01-fresh', refresh_token: 'rt-fresh', expires_in: 28800,
          account: { uuid: 'acct-1', email_address: 'a@example.com' }, organization: { uuid: 'org-1', name: 'Team' },
        });
      };
      let opened = '';
      const offered = [];
      const port = {
        report: (line) => { if (line.startsWith('Open: ')) opened = line.slice('Open: '.length); },
        ask: async (request) => {
          if (request.secret) return 'code-from-claude#' + new URL(opened).searchParams.get('state');
          offered.push(request.fallback);

          return 'claude-opus-4-7';
        },
        skippable: async () => null,
      };
      const outcome = await connectProvider('claude', port, { account: ${JSON.stringify(account)} });
      console.log(JSON.stringify({ outcome, opened, sent, offered }));
    `;

    const proc = await runToExit([process.execPath, '-e', runner], {
      cwd: repoRoot,
      // An empty PATH leaves no `xdg-open` to start a real browser.
      env: { ...process.env, KINU_HOME: home, PATH: scratchDir('no-browser'), NO_COLOR: '1' },
    });

    expect(proc.exitCode, proc.stderr).toBe(0);

    return v.parse(v.object({
      outcome: v.object({ kind: v.string(), summary: v.string(), detail: v.optional(v.string()) }),
      opened: v.string(),
      sent: v.array(v.tuple([v.string(), v.record(v.string(), v.string())])),
      offered: v.array(v.string()),
    }), JSON.parse(proc.stdout));
  }

  test('a pasted sign-in code is exchanged as Claude Code does and stores the login on this machine', async () => {
    const home = freshHome();
    const run = await connectClaude(home, 'main');
    const opened = new URL(run.opened);

    expect([opened.origin + opened.pathname, opened.searchParams.get('redirect_uri'), opened.searchParams.get('code')])
      .toEqual(['https://claude.ai/oauth/authorize', 'http://localhost:54545/callback', 'true']);
    expect(run.outcome).toEqual({ kind: 'connected', summary: 'Connected your Claude subscription', detail: 'Default model: claude/claude-opus-4-7' });
    expect(run.sent.map(([url, body]) => [url, body.grant_type, body.code, body.state])).toEqual([
      ['https://api.anthropic.com/v1/oauth/token', 'authorization_code', 'code-from-claude', opened.searchParams.get('state') ?? 'no state'],
    ]);

    const stored = v.parse(v.object({ providers: v.object({ claude: v.object({ accessToken: v.string(), refreshToken: v.string() }) }) }), parseJsonObject(readFileSync(join(home, 'config.json'), 'utf8')));

    expect(stored.providers.claude).toMatchObject({ accessToken: 'sk-ant-oat01-fresh', refreshToken: 'rt-fresh' });
  });

  test('a default the retired claude binary made up is not offered again; a model Claude serves is', async () => {
    const home = freshHome();

    await withDefaultModel(home, 'claude/claude-opus-4-x');
    expect((await connectClaude(home, 'main')).offered).toEqual(['claude-opus-4-7']);
  });

  test('a second account signs in beside the first and is listed by name', async () => {
    const home = freshHome();

    await connectClaude(home, 'main');
    expect((await connectClaude(home, 'work')).outcome.summary).toBe('Connected the Claude account work');
    const listed = (await runProviders(['list'], { home })).stdout.split('\n');
    const claude = listed.findIndex((line) => line.includes('Claude subscription'));

    expect(listed.slice(claude, claude + 3).join('\n')).toContain('accounts: main (default), work');
  });
});

/**
 * Resident sessions invalidate provider listings by signal, and each `kinu provider` runs in another
 * process, so the revision in config.json is the only carrier.
 */
describe('providers command — the provider revision', () => {
  function revisionOf(home: string): number {
    const parsed = v.safeParse(v.number(), parseJsonObject(
      readFileSync(join(home, 'config.json'), 'utf8'),
    ).providerRevision);

    return parsed.success ? parsed.output : 0;
  }

  test('a disconnect that removes a stored credential advances it', async () => {
    const home = freshHome();
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      providers: { openai: { apiKey: 'sk' } },
    }));
    expect(revisionOf(home)).toBe(0);

    const res = await runProviders(['disconnect', 'openai'], { home });

    expect(res.exitCode).toBe(0);
    expect(revisionOf(home)).toBe(1);
  });

  test('the opencode bridge advances it too, and each command advances it once', async () => {
    const home = freshHome();
    // Kinu stores no opencode credential, but a listing sweep probes that login, so a disconnect bumps the revision.
    expect((await runProviders(['disconnect', 'opencode'], { home })).exitCode).toBe(0);
    expect(revisionOf(home)).toBe(1);

    expect((await runProviders(['list'], { home })).exitCode).toBe(0);
    expect(revisionOf(home)).toBe(1);
  });
});

describe('providers command — disconnect', () => {
  function homeWith(config: JsonObject): string {
    const home = freshHome();
    writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    return home;
  }

  function readConfig(home: string): JsonObject {
    return parseJsonObject(readFileSync(join(home, 'config.json'), 'utf8'));
  }


  const DefaultModelSchema = v.object({
    localProfile: v.object({ catalog: v.object({ tiers: v.object({ default: v.object({ model: v.string() }) }) }) }),
  });

  test('removes the stored credential from disk and says the default model ran on it, leaving the default', async () => {
    const home = homeWith({
      providers: {
        codex: { accessToken: 'at-secret', refreshToken: 'rt-secret' },
        openai: { apiKey: 'sk-keep-me' },
      },
    });

    await withDefaultModel(home, 'codex/gpt-5.5');
    const res = await runProviders(['disconnect', 'codex'], { home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Removed the codex credential from this machine');
    expect(res.stdout).toContain('codex/gpt-5.5 runs on it');

    const config = readConfig(home);
    expect(config.providers).toEqual({ openai: { apiKey: 'sk-keep-me' } });
    expect(v.parse(DefaultModelSchema, config).localProfile.catalog.tiers.default.model).toBe('codex/gpt-5.5');
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain('secret');
  });

  test('an account is picked as the default, listed as it, and taken out of the default when removed', async () => {
    const home = homeWith({ providers: { anthropic: { apiKey: 'sk-main', accounts: { work: { apiKey: 'sk-work' } } } } });
    await withDefaultModel(home, 'anthropic/claude-x');
    const accountsLine = (out: string): string => out.split('\n').find((line) => line.includes('accounts:'))?.trim() ?? '';

    expect((await runProviders(['default', 'anthropic', 'work'], { home })).exitCode).toBe(0);
    expect(accountsLine((await runProviders(['list'], { home })).stdout)).toBe('accounts: main, work (default)');

    const removed = await runProviders(['disconnect', 'anthropic', 'work'], { home });
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain('was the default anthropic account');

    const config = readConfig(home);
    expect(config.providers).toEqual({ anthropic: { apiKey: 'sk-main', accounts: {} } });
    expect(v.parse(v.object({ localProfile: v.object({ catalog: v.object({ accounts: v.record(v.string(), v.string()) }) }) }), config)
      .localProfile.catalog.accounts).toEqual({});
  });

  test('disconnecting a provider takes its main account and keeps the others', async () => {
    const home = homeWith({ providers: { openai: { apiKey: 'sk-main', accounts: { work: { apiKey: 'sk-work' } } } } });
    expect((await runProviders(['disconnect', 'openai'], { home })).exitCode).toBe(0);
    expect(readConfig(home).providers).toEqual({ openai: { accounts: { work: { apiKey: 'sk-work' } } } });
  });

  test('says nothing about a default model that runs on another provider', async () => {
    const home = homeWith({ providers: { codex: { accessToken: 'at' }, openai: { apiKey: 'sk' } } });
    await withDefaultModel(home, 'openai/gpt-5.5');

    const res = await runProviders(['disconnect', 'codex'], { home });
    expect(res.stdout).not.toContain('runs on it');
    expect(v.parse(DefaultModelSchema, readConfig(home)).localProfile.catalog.tiers.default.model).toBe('openai/gpt-5.5');
  });

  test('says so when the provider was not connected, and changes nothing', async () => {
    const home = homeWith({ providers: { openai: { apiKey: 'sk' } } });
    const res = await runProviders(['disconnect', 'anthropic'], { home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('was not connected');
    expect(readConfig(home).providers).toEqual({ openai: { apiKey: 'sk' } });
  });

  test('warns that an env credential still overrides the removed file entry', async () => {
    const home = homeWith({ providers: { openai: { apiKey: 'sk' } } });
    const res = await runProviders(['disconnect', 'openai'], { home, env: { OPENAI_API_KEY: 'sk-env' } });
    expect(res.stdout).toContain('OPENAI_API_KEY is still set');
  });

  test('points the account and the opencode bridge at the login that owns them', async () => {
    const home = homeWith({});
    expect((await runProviders(['disconnect', 'cloudflare'], { home })).stdout).toContain('kinu logout');
    expect((await runProviders(['disconnect', 'opencode'], { home })).stdout).toContain('opencode auth logout');
  });

  test('a Claude login is removed from this machine like any stored credential', async () => {
    const home = homeWith({ providers: { claude: { accessToken: 'sk-ant-oat01-secret', refreshToken: 'rt-secret' }, openai: { apiKey: 'sk' } } });
    const res = await runProviders(['disconnect', 'claude'], { home });

    expect(res.stdout).toContain('Removed the claude credential from this machine');
    expect(readConfig(home).providers).toEqual({ openai: { apiKey: 'sk' } });
  });

  test('remove and rm are accepted spellings', async () => {
    for (const verb of ['remove', 'rm']) {
      const home = homeWith({ providers: { openrouter: { apiKey: 'sk' } } });
      expect((await runProviders([verb, 'openrouter'], { home })).stdout).toContain('Removed the openrouter credential from this machine');
      expect(readConfig(home).providers).toEqual({});
    }
  });

  test('rejects an unknown provider instead of silently doing nothing', async () => {
    const res = await runProviders(['disconnect', 'not-a-provider'], { home: freshHome() });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('Unknown provider "not-a-provider"');
  });
});
