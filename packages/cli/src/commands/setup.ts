import * as readline from 'node:readline';
import {
  createCodexOAuthClient,
  decodeCodexAccountId,
  tokensToCredential,
} from '@proteus/core';
import { loadConfigFile, saveConfigFile, type ProteusConfig } from '../config.js';
import { ACCENT, DIM, OK, WARN } from '../display.js';
import { authCommand, openBrowser } from './auth.js';

export async function setupCommand(opts: {
  origin?: string;
  provider?: string;
  model?: string;
  yes?: boolean;
  skipCloud?: boolean;
  localModel?: boolean;
  accountOnly?: boolean;
}): Promise<void> {
  console.log('');
  console.log(ACCENT('Proteus setup'));
  console.log(DIM('Connect your account and configure providers for cloud or local agents.'));
  console.log('');

  const config = loadConfigFile();
  let cloudReady = Boolean(config.accessToken);
  let cloudSkipped = Boolean(opts.skipCloud);
  if (cloudReady) {
    console.log(`${OK('✓')} Signed in${config.user?.email ? ` as ${ACCENT(config.user.email)}` : ''}`);
  }

  if (!opts.skipCloud && !config.accessToken) {
    const shouldLogin = opts.yes || await confirm('Sign in to your Proteus account now?', true);
    if (shouldLogin) {
      await authCommand({ origin: opts.origin });
      cloudReady = Boolean(loadConfigFile().accessToken);
    } else {
      cloudSkipped = true;
    }
  }

  if (opts.accountOnly) {
    if (cloudReady) {
      console.log(`${OK('✓')} Proteus account ready.`);
      console.log(DIM('Run proteus provider connect codex for local agents that should use your ChatGPT Codex subscription.'));
    } else {
      console.log(`${WARN('!')} Proteus account was not connected.`);
      console.log(DIM(`Run proteus auth${opts.origin ? ` --origin ${opts.origin}` : ''} when you are ready.`));
    }
    return;
  }

  if (!process.stdin.isTTY && !opts.yes && !opts.provider && !opts.localModel && !cloudSkipped && cloudReady) {
    console.log(`${OK('✓')} Proteus account ready.`);
    console.log(DIM('Run proteus provider connect <provider> to configure local agent model access.'));
    return;
  }

  const provider = normalizeProvider(opts.provider ?? (opts.yes ? 'codex' : await chooseProvider()));
  if (provider === 'skip') {
    console.log(`${WARN('!')} Skipped local model setup.`);
    console.log(DIM(cloudReady
      ? 'Cloud agents remain ready. Run proteus provider connect <provider> later for local agents.'
      : 'Run proteus setup later before creating agents.'));
    return;
  }

  const next = loadConfigFile();
  if (provider === 'codex') {
    const model = stripProviderPrefix(opts.model ?? await ask('Default Codex model', next.model?.startsWith('codex/') ? next.model.slice('codex/'.length) : 'gpt-5.5'), 'codex');
    const credential = await runCodexDeviceFlow();
    saveConfigFile(withProvider(next, {
      model: `codex/${model}`,
      providers: {
        ...(next.providers ?? {}),
        codex: {
          accessToken: credential.accessToken,
          refreshToken: credential.refreshToken,
          expiresAt: credential.expiresAt,
          metadata: credential.metadata,
        },
      },
    }));
    console.log(`${OK('✓')} Connected ChatGPT Codex subscription`);
    return;
  }

  if (provider === 'openai') {
    const key = await askSecret('OpenAI API key');
    const model = opts.model ?? await ask('Default model', next.model?.startsWith('openai/') ? next.model.slice('openai/'.length) : 'gpt-4o-mini');
    saveConfigFile(withProvider(next, {
      model: `openai/${model}`,
      providers: { ...(next.providers ?? {}), openai: { apiKey: key } },
    }));
    console.log(`${OK('✓')} Saved OpenAI credentials`);
    return;
  }

  if (provider === 'openrouter') {
    const key = await askSecret('OpenRouter API key');
    const model = opts.model ?? await ask('Default model', next.model?.startsWith('openrouter/') ? next.model.slice('openrouter/'.length) : 'openai/gpt-4o-mini');
    saveConfigFile(withProvider(next, {
      model: `openrouter/${model}`,
      providers: { ...(next.providers ?? {}), openrouter: { apiKey: key } },
    }));
    console.log(`${OK('✓')} Saved OpenRouter credentials`);
    return;
  }

  if (provider === 'anthropic') {
    const key = await askSecret('Anthropic API key');
    const model = opts.model ?? await ask('Default model', next.model?.startsWith('anthropic/') ? next.model.slice('anthropic/'.length) : 'claude-sonnet-4-5');
    saveConfigFile(withProvider(next, {
      model: `anthropic/${model}`,
      providers: { ...(next.providers ?? {}), anthropic: { apiKey: key } },
    }));
    console.log(`${OK('✓')} Saved Anthropic credentials`);
    return;
  }

  if (provider === 'openai-compatible') {
    const baseURL = await ask('Base URL', 'http://localhost:11434/v1');
    const apiKey = await askSecret('API key (use any non-empty value for local servers)', 'local');
    const model = opts.model ?? await ask('Default model', 'gpt-oss:20b');
    saveConfigFile(withProvider(next, {
      model: `openai-compat/${model}`,
      providers: {
        ...(next.providers ?? {}),
        openaiCompat: {
          ...(next.providers?.openaiCompat ?? {}),
          default: { baseURL, apiKey },
        },
      },
    }));
    console.log(`${OK('✓')} Saved OpenAI-compatible endpoint`);
    return;
  }

  throw new Error(`Unknown provider: ${provider}`);
}

function withProvider(config: ProteusConfig, patch: Pick<ProteusConfig, 'model' | 'providers'>): ProteusConfig {
  return {
    ...config,
    model: patch.model,
    providers: {
      ...(config.providers ?? {}),
      ...(patch.providers ?? {}),
      openaiCompat: {
        ...(config.providers?.openaiCompat ?? {}),
        ...(patch.providers?.openaiCompat ?? {}),
      },
    },
  };
}

async function chooseProvider(): Promise<string> {
  console.log(DIM('Local model provider:'));
  console.log(`  ${ACCENT('1')} ChatGPT Codex subscription`);
  console.log(`  ${ACCENT('2')} OpenAI API key`);
  console.log(`  ${ACCENT('3')} OpenRouter`);
  console.log(`  ${ACCENT('4')} Anthropic`);
  console.log(`  ${ACCENT('5')} OpenAI-compatible`);
  console.log(`  ${ACCENT('6')} Skip`);
  const value = await ask('Choice', '1');
  return value;
}

function normalizeProvider(value: string): 'codex' | 'openai' | 'openrouter' | 'anthropic' | 'openai-compatible' | 'skip' {
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'codex' || v === 'chatgpt' || v === 'chatgpt-codex') return 'codex';
  if (v === '2' || v === 'openai') return 'openai';
  if (v === '3' || v === 'openrouter') return 'openrouter';
  if (v === '4' || v === 'anthropic' || v === 'claude') return 'anthropic';
  if (v === '5' || v === 'openai-compatible' || v === 'compat' || v === 'ollama') return 'openai-compatible';
  if (v === '6' || v === 'skip' || v === 'none') return 'skip';
  throw new Error('Provider must be codex, openai, openrouter, anthropic, openai-compatible, or skip.');
}

async function runCodexDeviceFlow() {
  const client = createCodexOAuthClient();
  const flow = await client.startDeviceFlow();
  console.log('');
  console.log(`${DIM('Open:')} ${ACCENT(flow.portalURL)}`);
  console.log(`${DIM('Code:')} ${ACCENT(flow.userCode)}`);
  console.log('');
  openBrowser(flow.portalURL);

  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await delay(Math.max(3, flow.pollIntervalSec) * 1000);
    const tokens = await client.pollDeviceFlow(flow.deviceAuthId, flow.userCode);
    if (!tokens) {
      process.stdout.write('.');
      continue;
    }
    console.log('');
    const credential = tokensToCredential(tokens);
    const accountId = decodeCodexAccountId(credential.accessToken);
    return {
      ...credential,
      metadata: accountId ? { accountId } : credential.metadata,
    };
  }
  throw new Error('Codex login expired. Run proteus setup again.');
}

function stripProviderPrefix(model: string, provider: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function confirm(label: string, fallback: boolean): Promise<boolean> {
  const answer = (await ask(label, fallback ? 'Y/n' : 'y/N')).trim().toLowerCase();
  if (!answer || answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  return fallback;
}

async function ask(label: string, fallback = ''): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    const suffix = fallback ? ` ${DIM(`[${fallback}]`)}` : '';
    rl.question(`${DIM(label)}${suffix} ${ACCENT('›')} `, resolve);
  });
  rl.close();
  return answer.trim() || fallback;
}

async function askSecret(label: string, fallback = ''): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return ask(label, fallback);
  }

  process.stdout.write(`${DIM(label)}${fallback ? DIM(' [saved/default]') : ''} ${ACCENT('›')} `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  let value = '';
  return new Promise<string>((resolve) => {
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          process.stdin.setRawMode(false);
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value.trim() || fallback);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += ch;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}
