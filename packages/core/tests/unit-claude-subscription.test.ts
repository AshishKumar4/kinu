// The Claude subscription's wire is Claude Code's CLI as oh-my-pi sends it. Every expected value below
// is read from oh-my-pi's source (github.com/can1357/oh-my-pi) at commit 62bc57be1b, 2026-09-24:
//   packages/ai/src/providers/anthropic.ts  buildAnthropicHeaders' OAuth branch (L383-400), claudeCodeHeaders
//     (L586-595), mapStainlessOs/Arch (L551-583), buildClaudeCodeBetas (L217-290), createClaudeBillingHeader
//     (L621-633), patchCch (L635-672), buildAnthropicSystemBlocks (L3286-3313), buildParams' field order
//     (L4468-4489), the OAuth `?beta=true` URL (L2198) and the version-too-old retry (L3021-3044)
//   packages/ai/src/providers/claude-code-fingerprint.ts  version pattern, identity line, 64k output cap
//   packages/ai/src/providers/anthropic-identity.ts  the `_` tool prefix and its server-tool exemptions
//   packages/coding-agent/src/session/session-metadata.ts  metadata.user_id without a known account
//   packages/catalog/src/compat/rules/auth/anthropic.kdl and registry/engine/oauth-code.ts  the sign-in
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { jsonSchema, streamText, tool, type ModelMessage } from 'ai';
import * as v from 'valibot';
import { createClaudeProvider, CLAUDE_CRED_KEY } from '../src/providers/claude';
import { cacheableSystem, resolvePromptCacheStrategy } from '../src/prompting/cache-breakpoints';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';
import { OAuthTokenError } from '../src/providers/oauth-token-error';
import type { AuthResolution, ProviderDeps, ProviderWaitInfo } from '../src/providers/types';
import { asFetchFunction } from '../src/providers/fetch-shim';
import { parseJsonObject, type JsonObject } from '../src/utils/json';
import { callAccountOf, quotaWindowText } from '../src/providers/quota';
import { claudeCodeFrom, createClaudeOAuthClient, startClaudeSignIn } from '../src/providers/claude-oauth';

interface Sent {
  readonly url: string;
  readonly headers: [string, string][];
  readonly text: string;
  readonly body: JsonObject;
}

const SentHeadersSchema = v.record(v.string(), v.string());

const SystemBlocksSchema = v.array(v.looseObject({ text: v.string(), cache_control: v.optional(v.looseObject({ type: v.string() })) }));

const SSE_TOOL_CALL = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-7","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"_read","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"src/parser.ts\\"}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":9}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

function sse(headers: Record<string, string> = {}): Response {
  return new Response(SSE_TOOL_CALL, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

function anthropicError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers each POST with the next scripted response and keeps what was sent. */
function wire(responses: (() => Response)[]) {
  const sent: Sent[] = [];

  const fetchFn = asFetchFunction(async (input, init) => {
    const text = await new Response(init?.body ?? null).text();
    const headers = Object.entries(v.parse(SentHeadersSchema, init?.headers));

    sent.push({ url: input instanceof Request ? input.url : input.toString(), headers, text, body: parseJsonObject(text) });
    const next = responses.shift();

    if (next === undefined) throw new Error('an unscripted request left the provider');

    return next();
  });

  return { sent, fetchFn };
}

function only(sent: readonly Sent[], index = 0): Sent {
  const request = sent[index];

  if (request === undefined) throw new Error(`request ${String(index)} was never sent`);

  return request;
}

function deps(fetchFn: typeof fetch, logins: (AuthResolution | 'revoked')[], affinity?: string): ProviderDeps & { asked: (boolean | undefined)[] } {
  const asked: (boolean | undefined)[] = [];

  return {
    env: {},
    fetch: fetchFn,
    asked,
    ...(affinity !== undefined && { sessionAffinity: affinity }),
    async getAuth(key, opts) {
      expect(key).toBe(CLAUDE_CRED_KEY);
      asked.push(opts?.forceRefresh);
      const next = logins.length > 1 ? logins.shift() : logins[0];

      if (next === 'revoked') throw new OAuthTokenError('codex', 'invalid_grant', 'refresh token revoked');

      return next ?? null;
    },
    async hasCredential(key) { return key === CLAUDE_CRED_KEY; },
  };
}

const login = (token: string): AuthResolution => ({ headers: { Authorization: `Bearer ${token}` }, credentialKey: CLAUDE_CRED_KEY });

const READ = tool({ description: 'Read a file.', inputSchema: jsonSchema<{ path: string }>({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }) });

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'Please refactor the parser module into two files.' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'toolu_0', toolName: 'read', input: { path: 'src/lexer.ts' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_0', toolName: 'read', output: { type: 'text', value: 'export {}' } }] },
];

/** One streamed turn; a failed call rejects with the error the stream carried, as a turn shows it. */
async function turn(provider: ReturnType<typeof createClaudeProvider>, providerDeps: ProviderDeps) {
  let failure: unknown;

  const result = streamText({
    model: provider.createModel('claude-opus-4-7', providerDeps),
    system: cacheableSystem('You are Kinu.', resolvePromptCacheStrategy('claude')),
    messages: HISTORY,
    tools: { read: READ },
    maxOutputTokens: 100_000,
    onError: ({ error }) => { failure = error; },
  });

  await result.consumeStream();

  if (failure !== undefined) throw failure;

  return { calls: await result.toolCalls };
}

const STAINLESS_OS = new Map([['darwin', 'MacOS'], ['win32', 'Windows'], ['linux', 'Linux'], ['freebsd', 'FreeBSD']]);

const STAINLESS_ARCH = new Map([['x64', 'x64'], ['arm64', 'arm64'], ['ia32', 'x86']]);

function versionOf(sent: Sent): string {
  const agent = new Map(sent.headers).get('User-Agent') ?? '';
  const version = /^claude-cli\/(\d+\.\d+\.\d+) \(external, cli\)$/.exec(agent)?.[1];

  if (version === undefined) throw new Error(`not Claude Code's User-Agent: ${agent}`);

  return version;
}

/** `cc_version=<v>.<first 3 hex of SHA-256("59cf53e54c78" + chars 4, 7, 20 of the first user message + v)>`. */
function billing(firstUserMessage: string, version: string, cch: string): string {
  const sample = [4, 7, 20].map((index) => firstUserMessage[index] ?? '0').join('');
  const suffix = createHash('sha256').update(`59cf53e54c78${sample}${version}`).digest('hex').slice(0, 3);

  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=cli; cch=${cch};`;
}

describe('the Claude subscription wire', () => {
  test('headers, URL, system blocks and body are Claude Code\'s, and the reply\'s tool name is the declared one', async () => {
    const { sent, fetchFn } = wire([sse]);
    const { calls } = await turn(createClaudeProvider(), deps(fetchFn, [login('sk-ant-oat01-first')], 'kinu-agent-1'));

    expect(calls.map((call) => [call.toolName, call.input])).toEqual([['read', { path: 'src/parser.ts' }]]);
    const request = only(sent);
    const version = versionOf(request);
    const sessionId = new Map(request.headers).get('X-Claude-Code-Session-Id') ?? '';

    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(request.url).toBe('https://api.anthropic.com/v1/messages?beta=true');

    expect(request.headers).toEqual([
      ['Accept', 'application/json'],
      ['Content-Type', 'application/json'],
      ['User-Agent', `claude-cli/${version} (external, cli)`],
      ['X-Claude-Code-Session-Id', sessionId],
      ['X-Stainless-Arch', STAINLESS_ARCH.get(process.arch) ?? `other::${process.arch}`],
      ['X-Stainless-Lang', 'js'],
      ['X-Stainless-OS', STAINLESS_OS.get(process.platform) ?? `Other::${process.platform}`],
      ['X-Stainless-Package-Version', '0.112.1'],
      ['X-Stainless-Retry-Count', '0'],
      ['X-Stainless-Runtime', 'node'],
      ['X-Stainless-Runtime-Version', 'v26.3.0'],
      ['X-Stainless-Timeout', '600'],
      ['anthropic-beta', 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,fallback-credit-2026-06-01'],
      ['anthropic-dangerous-direct-browser-access', 'true'],
      ['anthropic-version', '2023-06-01'],
      ['Authorization', 'Bearer sk-ant-oat01-first'],
      ['x-app', 'cli'],
      ['Connection', 'keep-alive'],
      ['Accept-Encoding', 'gzip, deflate, br, zstd'],
    ]);

    const cch = /cch=([0-9a-f]{5});/.exec(request.text)?.[1] ?? '';

    expect(request.body.system).toEqual([
      { type: 'text', text: billing('Please refactor the parser module into two files.', version, cch) },
      { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'You are Kinu.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);

    expect(Object.keys(request.body)).toEqual(['model', 'messages', 'system', 'tools', 'metadata', 'max_tokens', 'stream', 'tool_choice']);
    expect(request.body.metadata).toEqual({ user_id: JSON.stringify({ session_id: sessionId }) });
    expect(request.body.max_tokens).toBe(64_000);
    expect(request.body.tools).toMatchObject([{ name: '_read' }]);
    expect(JSON.stringify(request.body.messages)).toContain('"type":"tool_use","id":"toolu_0","name":"_read"');
  });

  test('the cch attestation is XXH64 of the sent bytes with the placeholder in place, seed 0x4d659218e32a3268', async () => {
    const { sent, fetchFn } = wire([sse]);

    await turn(createClaudeProvider(), deps(fetchFn, [login('sk-ant-oat01-first')], 'kinu-agent-1'));
    const { text } = only(sent);
    const cch = /cch=([0-9a-f]{5});/.exec(text)?.[1];
    const unattested = new TextEncoder().encode(text.replace(`cch=${cch ?? ''};`, 'cch=00000;'));
    const digest = BigInt.asUintN(64, BigInt(Bun.hash.xxHash64(unattested, 0x4d659218e32a3268n)));

    expect(cch).toBe((digest & 0xfffffn).toString(16).padStart(5, '0'));
  });

  test('one conversation keeps one session id across providers; another conversation gets its own', async () => {
    const { sent, fetchFn } = wire([sse, sse, sse]);

    await turn(createClaudeProvider(), deps(fetchFn, [login('t')], 'kinu-agent-1'));
    await turn(createClaudeProvider(), deps(fetchFn, [login('t')], 'kinu-agent-1'));
    await turn(createClaudeProvider(), deps(fetchFn, [login('t')], 'kinu-agent-2'));
    const ids = sent.map((request) => new Map(request.headers).get('X-Claude-Code-Session-Id'));

    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  test('with every breakpoint taken, the identity block takes the system prompt\'s and the request stays within four', async () => {
    const { sent, fetchFn } = wire([sse]);
    const marked = { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } } as const;

    const result = streamText({
      model: createClaudeProvider().createModel('claude-opus-4-7', deps(fetchFn, [login('t')], 'kinu-agent-1')),
      system: cacheableSystem('You are Kinu.', resolvePromptCacheStrategy('claude')),
      messages: [
        { role: 'user', content: 'Please refactor the parser module into two files.', providerOptions: marked },
        { role: 'assistant', content: 'Reading it first.' },
        { role: 'user', content: 'Go on.', providerOptions: marked },
      ],
      tools: { read: tool({ ...READ, providerOptions: marked }) },
    });

    await result.consumeStream();
    const request = only(sent);
    const system = v.parse(SystemBlocksSchema, request.body.system);

    expect(request.text.match(/"cache_control"/g)?.length).toBe(4);
    expect(system.map((block) => block.cache_control !== undefined)).toEqual([false, true, false]);
  });

  test('a refusal naming a newer Claude Code release is retried once at that release, which the provider then keeps', async () => {
    const recorded = createRecordingLogger();
    const restore = setDiagnosticsSink(recorded);
    const tooOld = () => anthropicError(400, 'invalid_request_error', 'claude_code_version_too_old: Claude Code version 2.9.0 or newer is required.');
    const { sent, fetchFn } = wire([tooOld, sse, sse]);
    const provider = createClaudeProvider();

    try {
      const first = await turn(provider, deps(fetchFn, [login('t')], 'kinu-agent-1'));
      const second = await turn(provider, deps(fetchFn, [login('t')], 'kinu-agent-1'));

      expect([first.calls.length, second.calls.length]).toEqual([1, 1]);
    } finally {
      restore();
    }

    const pinned = versionOf(only(sent));

    expect(sent.map(versionOf)).toEqual([pinned, '2.9.0', '2.9.0']);
    expect(only(sent, 1).text).toContain('cc_version=2.9.0.');
    expect(recorded.emitted.filter((line) => line.event === 'provider.claude_code_version_adopted').map((line) => line.fields))
      .toEqual([{ from: pinned, to: '2.9.0' }]);
  });

  test('a second refusal at the adopted release is shown, not retried again', async () => {
    const tooOld = () => anthropicError(400, 'invalid_request_error', 'claude_code_version_too_old: Claude Code version 2.9.0 or newer is required.');
    const { sent, fetchFn } = wire([tooOld, tooOld]);

    await expect(turn(createClaudeProvider(), deps(fetchFn, [login('t')], 'kinu-agent-1')))
      .rejects.toThrow('Claude Code version 2.9.0 or newer is required');
    expect(sent.length).toBe(2);
  });

  test('a refused login is refreshed once; refused again it names the remedy and records the refusal', async () => {
    const recorded = createRecordingLogger();
    const restore = setDiagnosticsSink(recorded);
    const refused = () => anthropicError(401, 'authentication_error', 'Invalid bearer token');
    const { sent, fetchFn } = wire([refused, refused]);
    const providerDeps = deps(fetchFn, [login('sk-ant-oat01-stale'), login('sk-ant-oat01-fresh')], 'kinu-agent-1');

    try {
      await expect(turn(createClaudeProvider(), providerDeps))
        .rejects.toThrow('Your Claude login is no longer valid. Reconnect Claude in User settings, or run `kinu provider connect claude`.');
    } finally {
      restore();
    }

    expect(providerDeps.asked).toEqual([undefined, true]);
    expect(sent.map((request) => new Map(request.headers).get('Authorization'))).toEqual(['Bearer sk-ant-oat01-stale', 'Bearer sk-ant-oat01-fresh']);
    expect(recorded.emitted.filter((line) => line.event === 'provider.claude_login_refused').map((line) => line.code)).toEqual(['denied']);
  });

  test('the subscription\'s 5-hour and weekly windows are read off the reply for the account that paid', async () => {
    const now = Date.parse('2026-09-24T12:00:00Z');

    const windows = () => sse({
      'anthropic-ratelimit-unified-5h-utilization': '0.37',
      'anthropic-ratelimit-unified-5h-reset': String((now + 2 * 3_600_000) / 1_000),
      'anthropic-ratelimit-unified-7d-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-reset': String((now + 3 * 86_400_000) / 1_000),
    });

    const { fetchFn } = wire([windows]);
    const providerDeps = deps(fetchFn, [{ headers: { Authorization: 'Bearer t' }, credentialKey: 'claude.oauth@work' }], 'kinu-agent-1');
    const result = streamText({ model: createClaudeProvider().createModel('claude-opus-4-7', providerDeps), prompt: 'hello' });

    await result.consumeStream();
    const account = callAccountOf({ headers: (await result.response).headers });

    expect([account?.provider, account?.name]).toEqual(['claude', 'work']);
    expect(account?.quota?.windows.map((window) => quotaWindowText(window, now))).toEqual([
      '37% of the 5h window used, resets in 2h',
      '12% of the 7d window used, resets in 3d',
    ]);
  });

  test('a passing rate limit is waited out as for every provider, and the turn goes through', async () => {
    const busy = () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited.' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '0' },
    });

    const { sent, fetchFn } = wire([busy, sse]);
    const waits: ProviderWaitInfo[] = [];
    const { calls } = await turn(createClaudeProvider(), { ...deps(fetchFn, [login('t')], 'kinu-agent-1'), onProviderWait: (info) => waits.push(info) });

    expect([calls.length, sent.length]).toEqual([1, 2]);
    expect(only(sent, 1).text).toBe(only(sent).text);
    expect(waits.map((wait) => [wait.provider, wait.status, wait.source, wait.waitMs])).toEqual([['claude', 429, 'header', 0]]);
  });

  test('a spent subscription window ends the turn once as a budget failure naming its reset, with no wait and no other provider', async () => {
    const now = Date.now();
    const recorded = createRecordingLogger();
    const restore = setDiagnosticsSink(recorded);

    const spent = () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your account\'s rate limit. Please try again later.' } }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '7200',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': String(Math.floor((now + 2 * 3_600_000) / 1_000)),
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
      },
    });

    const { sent, fetchFn } = wire([spent]);
    const providerDeps = deps(fetchFn, [{ headers: { Authorization: 'Bearer t' }, credentialKey: 'claude.oauth@work' }], 'kinu-agent-1');

    try {
      const failed = turn(createClaudeProvider(), providerDeps);

      await expect(failed).rejects.toThrow(/^Claude usage limit reached on the account work: 100% of the 5h window used, resets in (1h 59m|2h)\.$/);
      await expect(failed).rejects.toHaveProperty('cause.code', 'budget');
    } finally {
      restore();
    }

    expect(sent.length).toBe(1);
    expect(recorded.emitted.filter((line) => line.event === 'provider.claude_usage_limit').map((line) => [line.code, line.fields])).toEqual([['budget', { model: 'claude-opus-4-7', account: 'work' }]]);
  });

  test('a subscription whose included usage is used up is a budget failure in the provider\'s words', async () => {
    const credits = () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage credits are required for this model.', details: { error_code: 'credits_required' } } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });

    const { sent, fetchFn } = wire([credits]);
    const failed = turn(createClaudeProvider(), deps(fetchFn, [login('t')], 'kinu-agent-1'));

    await expect(failed).rejects.toThrow('Claude usage limit reached on the account main: Usage credits are required for this model.');
    await expect(failed).rejects.toHaveProperty('cause.code', 'budget');
    expect(sent.length).toBe(1);
  });

  test('a revoked refresh token is the same remedy, with nothing sent', async () => {
    const { sent, fetchFn } = wire([]);

    await expect(turn(createClaudeProvider(), deps(fetchFn, ['revoked'], 'kinu-agent-1'))).rejects.toThrow('Your Claude login is no longer valid.');
    expect(sent).toEqual([]);
  });

  test('a model name the retired claude binary made up is refused before anything is sent, pointing to /model', () => {
    const { sent, fetchFn } = wire([]);

    for (const retired of ['claude-opus-4-x', 'claude-sonnet-4-x', 'claude-haiku-4-x']) {
      expect(() => createClaudeProvider().createModel(retired, deps(fetchFn, [login('t')]))).toThrow('Pick a Claude model with /model.');
    }

    expect(sent).toEqual([]);
  });
});

describe('the Claude sign-in', () => {
  test('the authorize address is Claude Code\'s, with a PKCE challenge of its verifier', async () => {
    const signIn = await startClaudeSignIn();
    const url = new URL(signIn.url);
    const challenge = createHash('sha256').update(signIn.verifier).digest('base64url');

    expect(`${url.origin}${url.pathname}`).toBe('https://claude.ai/oauth/authorize');
    expect([...url.searchParams]).toEqual([
      ['client_id', '9d1c250a-e61b-44d9-88ed-5944d1962f5e'],
      ['response_type', 'code'],
      ['redirect_uri', 'http://localhost:54545/callback'],
      ['scope', 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'],
      ['code_challenge', challenge],
      ['code_challenge_method', 'S256'],
      ['state', signIn.state],
      ['code', 'true'],
    ]);
    expect(signIn.state).toMatch(/^[0-9a-f]{32}$/);
  });

  test('the code is exchanged with its verifier and state, and the login keeps who signed in', async () => {
    const signIn = await startClaudeSignIn();
    const sent: [string, string][] = [];

    const client = createClaudeOAuthClient(asFetchFunction(async (input, init) => {
      sent.push([input instanceof Request ? input.url : input.toString(), await new Response(init?.body ?? null).text()]);

      return Response.json({
        access_token: 'sk-ant-oat01-new', refresh_token: 'rt-new', expires_in: 28_800,
        account: { uuid: 'acct-1', email_address: 'a@example.com' }, organization: { uuid: 'org-1', name: 'Team' },
      });
    }));

    const signedIn = await client.exchange(signIn, 'code-1');

    expect(sent).toEqual([['https://api.anthropic.com/v1/oauth/token', JSON.stringify({
      grant_type: 'authorization_code', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', code: 'code-1',
      redirect_uri: 'http://localhost:54545/callback', code_verifier: signIn.verifier, state: signIn.state,
    })]]);
    expect(signedIn).toMatchObject({
      kind: 'oauth', accessToken: 'sk-ant-oat01-new', refreshToken: 'rt-new',
      metadata: { accountUuid: 'acct-1', email: 'a@example.com', orgUuid: 'org-1', orgName: 'Team' },
    });
  });

  test('what comes back is the address, `code#state`, or the bare code; another sign-in\'s state is refused', () => {
    expect(claudeCodeFrom('http://localhost:54545/callback?code=abc&state=s1', 's1')).toBe('abc');
    expect(claudeCodeFrom(' abc#s1 ', 's1')).toBe('abc');
    expect(claudeCodeFrom('abc', 's1')).toBe('abc');
    expect(() => claudeCodeFrom('abc#s2', 's1')).toThrow('that code belongs to another sign-in; start it again');
    expect(() => claudeCodeFrom('http://localhost:54545/callback?error=access_denied&state=s1', 's1')).toThrow('Claude refused the sign-in: access_denied');
  });
});
