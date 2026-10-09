#!/usr/bin/env bun
/**
 * WHICH SESSION ID CHATGPT CACHES BEST UNDER, by hand, on a ChatGPT login: one per workspace, or one per account. Each
 * scheme gets its own salted prefix (shared guidance and tools, then a workspace's own lines, then its conversation),
 * sent through Kinu's own Codex model, so the bodies and headers are the product's. It prints every request's cached and
 * input tokens and, per scheme: a fresh workspace's first step on a warm account, the steady hit rate of later steps,
 * and the same with several workspaces at once. The login is read from omp's credential store, read-only, and never
 * printed.
 * `product` sends what the product sends (`accountSession` in codex.ts), as a check that it is the winner.
 *   bun evals/scripts/chatgpt-session-probe.ts [credential row id] [workspaces at once] [schemes, e.g. workspace,account]
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { jsonSchema, streamText, tool } from 'ai';
import * as v from 'valibot';
import { createCodexProvider } from '../../packages/core/src/providers/codex';
import { codexCredentialToHeaders } from '../../packages/core/src/providers/codex-oauth';
import { asFetchFunction } from '../../packages/core/src/providers/fetch-shim';
import { conversationUuid } from '../../packages/core/src/providers/util';

const [rowArg = '37', parallelArg = '8', schemesArg = 'workspace,account,product'] = process.argv.slice(2);

const SchemeSchema = v.picklist(['workspace', 'account', 'product']);

type Scheme = v.InferOutput<typeof SchemeSchema>;

const SCHEMES = v.parse(v.array(SchemeSchema), schemesArg.split(','));

const OmpOAuthSchema = v.object({ access: v.string(), accountId: v.optional(v.string()) });

function login(): Record<string, string> {
  const db = new Database(join(homedir(), '.omp/agent/agent.db'), { readonly: true });

  try {
    const row = db.query<{ data: string }, [number]>("SELECT data FROM auth_credentials WHERE id = ? AND provider = 'openai-codex' AND disabled_cause IS NULL").get(Number(rowArg));

    if (row === null) throw new Error(`no live openai-codex credential ${rowArg}`);
    const parsed = v.parse(OmpOAuthSchema, JSON.parse(row.data));

    return codexCredentialToHeaders({ kind: 'oauth', accessToken: parsed.access, ...(parsed.accountId !== undefined && { metadata: { accountId: parsed.accountId } }) });
  } finally {
    db.close();
  }
}

const HEADERS = login();

const PROMPTS = join(import.meta.dir, '../../packages/core/src/prompts');

/** Shared by every workspace: the product's own guidance text, about 7,000 tokens of it. */
const GUIDANCE = readdirSync(PROMPTS).filter((name) => name.endsWith('.md')).sort().map((name) => readFileSync(join(PROMPTS, name), 'utf8')).join('\n\n').slice(0, 28_000);

const TOOLS = Object.fromEntries(['file', 'shell', 'tasks'].map((name) => [name, tool({
  description: `The ${name} tool. ${GUIDANCE.slice(0, 600)}`,
  inputSchema: jsonSchema<{ op: string }>({ type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }),
})]));

const STEPS = ['Name one thing a team offsite needs.', 'And another.', 'One more, briefly.', 'Name a fourth.', 'A fifth, in three words.', 'Last one.'];

interface Sent {
  readonly scheme: string;
  readonly workspace: number;
  readonly step: number;
  readonly input: number;
  readonly cached: number;
}

const sent: Sent[] = [];

const provider = createCodexProvider();

/** One workspace's conversation of `steps` steps, under the session id the scheme gives it. */
async function workspace(scheme: Scheme, salt: string, index: number, steps: number): Promise<void> {
  // The scheme names the session itself, over whichever one the product would send; `product` leaves it.
  const session = scheme === 'product' ? null : conversationUuid(scheme === 'account' ? `probe-account-${salt}` : `probe-workspace-${salt}-${String(index)}`);

  const model = provider.createModel('gpt-5.5', {
    env: {}, hasCredential: async () => true, getAuth: async () => ({ headers: HEADERS }),
    fetch: asFetchFunction((input, init) => {
      const headers = new Headers(init?.headers);

      if (session !== null) headers.set('session_id', session);

      return fetch(input, { ...init, headers });
    }),
    workspaceAffinity: `probe-workspace-${salt}-${String(index)}`, sessionAffinity: `probe-conversation-${salt}-${String(index)}`,
  });

  const system = `${salt}\n\n${GUIDANCE}\n\nYou work in the workspace "Offsite ${String(index)}". Its purpose: plan offsite number ${String(index)} `
    + `for team ${String(index * 7919)}, keep notes short, and answer in one line.`;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (let step = 0; step < steps; step += 1) {
    messages.push({ role: 'user', content: STEPS[step] ?? 'Again.' });
    const result = streamText({ model, system, messages, tools: TOOLS, providerOptions: { openai: { reasoningEffort: 'low' } } });
    const text = await result.text;
    const usage = await result.usage;

    messages.push({ role: 'assistant', content: text });
    sent.push({ scheme, workspace: index, step, input: usage.inputTokens ?? 0, cached: usage.inputTokenDetails.cacheReadTokens ?? 0 });
    console.log(`${scheme} ws${String(index)} step${String(step)}: ${String(usage.inputTokenDetails.cacheReadTokens ?? 0)}/${String(usage.inputTokens ?? 0)}`);
  }
}

const hit = (each: Sent): boolean => each.cached >= 1024;

function share(rows: readonly Sent[]): string {
  return `${String(rows.filter(hit).length)}/${String(rows.length)} hit, ${String(rows.reduce((sum, each) => sum + each.cached, 0))}/${String(rows.reduce((sum, each) => sum + each.input, 0))} tokens read`;
}

const run = crypto.randomUUID().slice(0, 8);

for (const scheme of SCHEMES) {
  const salt = `probe ${run} ${scheme}`;

  // A warm account: one workspace's conversation, then fresh workspaces one after another.
  await workspace(scheme, salt, 0, 6);

  for (let index = 1; index <= 5; index += 1) await workspace(scheme, salt, index, 2);

  // Then several at once, each a fresh workspace on the same account.
  await Promise.all(Array.from({ length: Number(parallelArg) }, (_, at) => workspace(scheme, salt, 100 + at, 4)));
}

for (const scheme of SCHEMES) {
  const mine = sent.filter((each) => each.scheme === scheme);
  const sequential = mine.filter((each) => each.workspace < 100);
  const parallel = mine.filter((each) => each.workspace >= 100);

  console.log(`\n${scheme} session id:`);
  console.log(`  fresh workspace, first step (warm account): ${share(sequential.filter((each) => each.workspace > 0 && each.step === 0))}`);
  console.log(`  later steps, one at a time: ${share(sequential.filter((each) => each.step > 0))}`);
  console.log(`  ${parallelArg} at once, first steps: ${share(parallel.filter((each) => each.step === 0))}`);
  console.log(`  ${parallelArg} at once, later steps: ${share(parallel.filter((each) => each.step > 0))}`);
}
