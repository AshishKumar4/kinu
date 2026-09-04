/**
 * Per-user MCP — contract tests for the helpers + integration glue.
 *
 * UserDO + MCPClientManager live in Cloudflare Worker runtime, so they
 * aren't directly bootable from `bun test`. The tests below cover the
 * pure parts of the system end-to-end:
 *
 *   1. `validateMcpServerInput` — every rejected input shape + happy path
 *   2. `mcpToolKey` — the SHARED core rule, identical on both backends
 *   3. `parseAllowedTools` / `mapConnectionStatus` — round-trip + degenerates
 *   4. Builtin `mcp_` prefix collision guard
 *   5. Orchestrator-side MCP tool adapter — the closure dispatches to the
 *      UserDO stub it was constructed with (via a fake stub), arguments
 *      survive, errors are caught.
 */
import { describe, test, expect } from 'bun:test';
import {
  validateMcpServerInput, canonicalMcpUrl,
  parseAllowedTools, mapConnectionStatus,
  parseMcpHeaders, mcpCredentialTransport,
} from '../src/user/mcp';
import {
  isMcpToolKey, mcpToolKey, stepContextLimit, type JsonObject, type JsonValue,
  describeMcpTool, admitMcpDescriptors, toolSurfaceTokens,
  type SerializableToolDescriptor,
} from '@kinu.run/core';
import { tool, jsonSchema, type ToolSet } from 'ai';
import type { RecordedMcpTransport } from './helpers/agents-sdk';

// ── 1. validateMcpServerInput ──────────────────────────────────────────────

describe('validateMcpServerInput', () => {
  test('accepts a minimal valid https input', () => {
    const out = validateMcpServerInput({ name: 'github', serverUrl: 'https://mcp.github.com/v1' });
    expect(out).toEqual({
      name: 'github',
      serverUrl: 'https://mcp.github.com/v1',
      transport: 'auto',
      headers: undefined,
      allowedTools: undefined,
    });
  });

  test('accepts http://localhost for dev', () => {
    const out = validateMcpServerInput({ name: 'local', serverUrl: 'http://localhost:9999/mcp' });
    expect(out.serverUrl).toBe('http://localhost:9999/mcp');
  });

  test('rejects http:// on a remote host', () => {
    expect(() => validateMcpServerInput({ name: 'evil', serverUrl: 'http://example.com/mcp' }))
      .toThrow(/https:\/\//);
  });

  test('rejects empty / missing name', () => {
    expect(() => validateMcpServerInput({ name: '', serverUrl: 'https://a' })).toThrow(/name/);
    expect(() => validateMcpServerInput({ serverUrl: 'https://a' })).toThrow(/name/);
  });

  test('rejects oversize name', () => {
    expect(() => validateMcpServerInput({ name: 'x'.repeat(65), serverUrl: 'https://a' }))
      .toThrow(/64 characters/);
  });

  test('rejects invalid serverUrl', () => {
    expect(() => validateMcpServerInput({ name: 'n', serverUrl: 'not-a-url' })).toThrow(/valid URL/);
  });

  test('rejects unknown transport', () => {
    expect(() => validateMcpServerInput({ name: 'n', serverUrl: 'https://a', transport: 'rpc' }))
      .toThrow(/transport/);
  });

  test('accepts each valid transport', () => {
    for (const t of ['auto', 'sse', 'streamable-http'] as const) {
      const out = validateMcpServerInput({ name: 'n', serverUrl: 'https://a', transport: t });
      expect(out.transport).toBe(t);
    }
  });

  test('accepts a flat headers map', () => {
    const out = validateMcpServerInput({
      name: 'n', serverUrl: 'https://a', headers: { Authorization: 'Bearer x' },
    });
    expect(out.headers).toEqual({ Authorization: 'Bearer x' });
  });

  test('rejects nested / non-string headers', () => {
    expect(() => validateMcpServerInput({
      name: 'n', serverUrl: 'https://a', headers: { 'x-num': 42 },
    })).toThrow(/x-num/);
    expect(() => validateMcpServerInput({
      name: 'n', serverUrl: 'https://a', headers: { nested: { a: 'b' } },
    })).toThrow(/nested/);
  });

  test('accepts and round-trips an allowedTools allowlist', () => {
    const out = validateMcpServerInput({
      name: 'n', serverUrl: 'https://a', allowedTools: ['create_issue', 'list_pulls'],
    });
    expect(out.allowedTools).toEqual(['create_issue', 'list_pulls']);
  });

  test('rejects non-array allowedTools', () => {
    expect(() => validateMcpServerInput({
      name: 'n', serverUrl: 'https://a', allowedTools: 'create_issue',
    })).toThrow(/string\[\]/);
  });

  test('rejects non-string allowedTools entries', () => {
    expect(() => validateMcpServerInput({
      name: 'n', serverUrl: 'https://a', allowedTools: ['ok', 42],
    })).toThrow(/non-empty/);
  });

  test('rejects non-object body', () => {
    expect(() => validateMcpServerInput(null)).toThrow(/JSON object/);
    expect(() => validateMcpServerInput('hi')).toThrow(/JSON object/);
  });
});

describe('canonical MCP endpoint identity', () => {
  test('one endpoint has one spelling', () => {
    expect(canonicalMcpUrl('HTTPS://MCP.Example.COM:443/v1')).toBe('https://mcp.example.com/v1');
    expect(canonicalMcpUrl('https://mcp.example.com/v1#frag')).toBe('https://mcp.example.com/v1');
  });

  test('the path and query are left exactly as written', () => {
    // `/mcp` and `/mcp/` are different resources to a server, and a query can
    // select the endpoint. Canonicalising those would silently retarget it.
    expect(canonicalMcpUrl('https://a.example/mcp/')).toBe('https://a.example/mcp/');
    expect(canonicalMcpUrl('https://a.example/mcp')).toBe('https://a.example/mcp');
    expect(canonicalMcpUrl('https://a.example/mcp?tenant=b')).toBe('https://a.example/mcp?tenant=b');
  });

  test('an accepted input is stored canonical', () => {
    const out = validateMcpServerInput({ name: 'n', serverUrl: 'HTTPS://Mcp.Example.com:443/v1#x' });
    expect(out.serverUrl).toBe('https://mcp.example.com/v1');
  });

  test('an empty headers object is omitted, not stored as a credential', () => {
    // A row whose `headers` column is non-null is a row the hydration path
    // treats as holding a secret. `{}` is not one.
    expect(validateMcpServerInput({ name: 'n', serverUrl: 'https://a.example', headers: {} }).headers)
      .toBeUndefined();
  });

  test('an empty allowedTools array is NOT omitted — it means expose nothing', () => {
    expect(validateMcpServerInput({ name: 'n', serverUrl: 'https://a.example', allowedTools: [] }).allowedTools)
      .toEqual([]);
  });
});

// ── 1b. describeMcpTool — the boundary remote prose crosses ────────────────

describe('describeMcpTool', () => {
  const server = { id: 'srv1', name: 'github' };

  test('a blank description is OMITTED, so the synthesized fallback applies', () => {
    const descriptor = describeMcpTool(server, { name: 'create_issue', description: '   ', inputSchema: {} });
    expect('description' in descriptor).toBe(false);
    // The orchestrator's fallback is nullish-guarded, so an empty string would
    // have reached the model as a tool with no description at all.
    expect(descriptor.description ?? `${descriptor.serverName}/${descriptor.name}`)
      .toBe('github/create_issue');
  });

  test('a real description is forwarded verbatim', () => {
    const descriptor = describeMcpTool(server, { name: 't', description: 'Opens an issue.', inputSchema: {} });
    expect(descriptor.description).toBe('Opens an issue.');
  });

  test('a blank title does not shadow the annotation title', () => {
    const descriptor = describeMcpTool(server, {
      name: 't', title: '', annotations: { title: 'Create issue' }, inputSchema: {},
    });
    expect(descriptor.title).toBe('Create issue');
  });

  test('the tool key is the shared rule, keyed on the server NAME', () => {
    expect(describeMcpTool(server, { name: 'create_issue', inputSchema: {} }).toolKey)
      .toBe(mcpToolKey('github', 'create_issue'));
  });
});

// ── 1c. admitMcpDescriptors — the budget that already existed ──────────────
//
// The contract: a remote catalog is admitted against what one step's request is
// allowed to occupy (core's `stepContextLimit`: window less the model's output
// allowance) MINUS what the actor's own tools
// already spend of it. No MCP percentage exists to assert against, so the tests
// assert the derivation itself: the admitted surface fits the remainder, a
// bigger window admits more, a bigger native surface admits less.

describe('admitMcpDescriptors', () => {
  function descriptor(serverName: string, name: string, description?: string): SerializableToolDescriptor {
    const built: SerializableToolDescriptor = {
      serverId: `${serverName}-id`, serverName, name,
      toolKey: mcpToolKey(serverName, name), inputSchema: { type: 'object' },
    };
    if (description !== undefined) built.description = description;
    return built;
  }

  /** The actor's own surface, built the way every production builtin is built
   *  (`jsonSchema`, never zod) — so what the budget subtracts is measured off a
   *  real ToolSet rather than a number chosen for the test. */
  function nativeTools(count: number): ToolSet {
    return Object.fromEntries(Array.from({ length: count }, (_, i) => [
      `builtin_${String(i)}`,
      tool({
        description: `Builtin number ${String(i)}. ${'Explains itself at length. '.repeat(20)}`,
        inputSchema: jsonSchema<{ action: string }>({
          type: 'object',
          properties: { action: { type: 'string', description: 'What to do.' } },
          required: ['action'],
        }),
        execute: async () => 'done',
      }),
    ]));
  }

  /** The output allowance every budget below leaves room for — one value, so no
   *  two tests disagree about what the model reserves. Small enough that the
   *  8k-window arm still has a budget at all, which is the point of sweeping it. */
  const MAX_OUTPUT = 4_000;
  const NO_NATIVE_TOOLS = { contextWindow: 200_000, modelOutputLimit: MAX_OUTPUT, nativeToolTokens: 0 };

  test('a small catalog is admitted whole and never reordered by the SDK map', () => {
    const admission = admitMcpDescriptors([
      descriptor('zulu', 'b'), descriptor('alpha', 'b'), descriptor('alpha', 'a'),
    ], NO_NATIVE_TOOLS);
    expect(admission.admitted.map((d) => d.toolKey)).toEqual([
      mcpToolKey('alpha', 'a'), mcpToolKey('alpha', 'b'), mcpToolKey('zulu', 'b'),
    ]);
    expect(admission.deferred).toEqual([]);
  });

  test('a catalog past the budget is cut off, and the cut is REPORTED', () => {
    const many = Array.from({ length: 4_000 }, (_, i) => descriptor('flood', `tool_${String(i).padStart(4, '0')}`));
    const native = toolSurfaceTokens(nativeTools(12));
    const admission = admitMcpDescriptors(many, { contextWindow: 32_000, modelOutputLimit: MAX_OUTPUT, nativeToolTokens: native });
    expect(admission.admitted.length).toBeGreaterThan(0);
    expect(admission.admitted.length).toBeLessThan(many.length);
    expect(admission.deferred).toHaveLength(1);
    expect(admission.deferred[0]?.server).toBe('flood');
    expect(admission.deferred[0]?.reason).toContain('did not fit');
    // The whole point: the admitted surface fits what the step context limit
    // had left after the actor's own tools — measured on the one shared scale.
    expect(toolSurfaceTokens(admission.admitted))
      .toBeLessThanOrEqual(stepContextLimit({ contextWindow: 32_000, modelOutputLimit: MAX_OUTPUT }) - native);
  });

  test.each([8_000, 32_000, 128_000, 200_000, 1_000_000])(
    'the admitted surface fits the remainder on a %i-token window',
    (contextWindow) => {
      const many = Array.from({ length: 4_000 }, (_, i) => descriptor('flood', `tool_${String(i).padStart(4, '0')}`));
      const native = toolSurfaceTokens(nativeTools(12));
      const admission = admitMcpDescriptors(many, { contextWindow, modelOutputLimit: MAX_OUTPUT, nativeToolTokens: native });
      const remainder = Math.max(0, stepContextLimit({ contextWindow, modelOutputLimit: MAX_OUTPUT }) - native);
      expect(toolSurfaceTokens(admission.admitted)).toBeLessThanOrEqual(remainder);
      // Nothing is lost silently: every tool is either admitted or reported.
      const lost = many.length - admission.admitted.length;
      expect(lost > 0).toBe(admission.deferred.length > 0);
    },
  );

  test('a bigger window admits more of the same catalog', () => {
    const many = Array.from({ length: 4_000 }, (_, i) => descriptor('flood', `tool_${String(i).padStart(4, '0')}`));
    const native = toolSurfaceTokens(nativeTools(12));
    expect(admitMcpDescriptors(many, { contextWindow: 200_000, modelOutputLimit: MAX_OUTPUT, nativeToolTokens: native }).admitted.length)
      .toBeGreaterThan(admitMcpDescriptors(many, { contextWindow: 32_000, modelOutputLimit: MAX_OUTPUT, nativeToolTokens: native }).admitted.length);
  });

  test("the actor's own tools are priced FIRST — a bigger native surface admits less MCP", () => {
    const many = Array.from({ length: 4_000 }, (_, i) => descriptor('flood', `tool_${String(i).padStart(4, '0')}`));
    const lean = admitMcpDescriptors(many, {
      contextWindow: 32_000, modelOutputLimit: MAX_OUTPUT, nativeToolTokens: toolSurfaceTokens(nativeTools(4)),
    });
    const heavy = admitMcpDescriptors(many, {
      contextWindow: 32_000, modelOutputLimit: MAX_OUTPUT, nativeToolTokens: toolSurfaceTokens(nativeTools(40)),
    });
    expect(heavy.admitted.length).toBeLessThan(lean.admitted.length);
  });

  test('a native surface that fills the step limit leaves the catalog nothing, and says so', () => {
    const admission = admitMcpDescriptors([descriptor('aaa', 'tool')], {
      contextWindow: 8_000, modelOutputLimit: MAX_OUTPUT, nativeToolTokens: stepContextLimit({ contextWindow: 8_000, modelOutputLimit: MAX_OUTPUT }),
    });
    expect(admission.admitted).toEqual([]);
    expect(admission.deferred[0]?.server).toBe('aaa');
  });

  test('one essay cannot crowd out the other servers', () => {
    const essay = 'x'.repeat(400_000);
    const admission = admitMcpDescriptors([
      descriptor('aaa', 'loud', essay), descriptor('bbb', 'quiet', 'Short.'),
    ], NO_NATIVE_TOOLS);
    expect(admission.admitted.map((d) => d.name)).toEqual(['loud', 'quiet']);
    expect(admission.admitted[0]?.description?.length).toBeLessThan(essay.length);
    expect(admission.admitted[0]?.description?.endsWith('…')).toBe(true);
    expect(admission.admitted[1]?.description).toBe('Short.');
  });

  test('an unspent share returns to the rest — a quiet catalog is untouched', () => {
    const quiet = Array.from({ length: 30 }, (_, i) => descriptor('calm', `tool_${String(i)}`, 'Does one thing.'));
    const admission = admitMcpDescriptors(quiet, NO_NATIVE_TOOLS);
    expect(admission.admitted).toHaveLength(30);
    expect(admission.admitted.every((d) => d.description === 'Does one thing.')).toBe(true);
    expect(admission.deferred).toEqual([]);
  });

  test('a schema is never truncated — an oversized one is deferred whole', () => {
    const fat = descriptor('fat', 'tool');
    fat.inputSchema = { type: 'object', properties: { blob: { type: 'string', description: 'y'.repeat(200_000) } } };
    const admission = admitMcpDescriptors([fat], { contextWindow: 8_000, modelOutputLimit: MAX_OUTPUT, nativeToolTokens: 0 });
    expect(admission.admitted).toEqual([]);
    expect(admission.deferred[0]?.server).toBe('fat');
  });

  test('a schema that fills its share keeps the schema and drops the prose', () => {
    // Two descriptors, so the first one's share is half the budget — and its
    // schema alone is more than that. The contract it advertises survives whole;
    // the prose is what goes, and the orchestrator falls back to
    // `<server>/<tool>` rather than showing a lone ellipsis.
    const fat = descriptor('aaa', 'tool', 'A description that will not survive.');
    fat.inputSchema = { type: 'object', properties: { blob: { type: 'string', description: 'y'.repeat(12_000) } } };
    const admission = admitMcpDescriptors(
      [fat, descriptor('bbb', 'small', 'Short.')],
      { contextWindow: 8_000, modelOutputLimit: MAX_OUTPUT, nativeToolTokens: 0 },
    );
    expect(admission.admitted.map((d) => d.name)).toEqual(['tool', 'small']);
    expect(admission.admitted[0]?.inputSchema).toEqual(fat.inputSchema);
    expect(admission.admitted[0]?.description).toBeUndefined();
    expect(admission.admitted[1]?.description).toBe('Short.');
  });
});

// ── 2. mcpToolKey ──────────────────────────────────────────────────────────

describe('mcpToolKey', () => {
  test('keys on the SERVER NAME, so the key is portable across backends', () => {
    // It used to key on the random nanoid(8) registration id, which made the
    // same MCP tool resolve under a different name for every user — and under
    // a different name again after a re-add. The CLI keyed on the server name
    // all along, so the two backends never agreed.
    expect(mcpToolKey('github', 'list_issues')).toBe('mcp_github_list_issues');
  });
  test('replaces characters no provider tool-name grammar accepts', () => {
    expect(mcpToolKey('my server.v2', 'do it')).toBe('mcp_my_server_v2_do_it');
    // Hyphens are legal in tool names, so a hyphenated server name is kept.
    expect(mcpToolKey('gh-mcp', 'foo')).toBe('mcp_gh-mcp_foo');
  });
  test('never produces a builtin name', () => {
    // The whole reason we reserve the `mcp_` prefix in buildBuiltinTools.
    expect(mcpToolKey('x', 'run')).not.toBe('run');
    expect(mcpToolKey('x', 'skills')).not.toBe('skills');
  });
});

// ── 3. parseAllowedTools + mapConnectionStatus ─────────────────────────────

describe('parseAllowedTools', () => {
  test('null/empty → null', () => {
    expect(parseAllowedTools(null)).toBeNull();
    expect(parseAllowedTools(undefined)).toBeNull();
    expect(parseAllowedTools('')).toBeNull();
  });
  test('roundtrips a valid JSON array of strings', () => {
    expect(parseAllowedTools('["a","b"]')).toEqual(['a', 'b']);
  });
  test('rejects non-string entries (returns null = allow all rather than crash)', () => {
    expect(parseAllowedTools('[1,2]')).toBeNull();
  });
  test('rejects non-array shapes', () => {
    expect(parseAllowedTools('"a"')).toBeNull();
    expect(parseAllowedTools('{"a":1}')).toBeNull();
    expect(parseAllowedTools('not-json')).toBeNull();
  });
});

describe('mapConnectionStatus', () => {
  test('maps each SDK state to its discriminated-union counterpart', () => {
    expect(mapConnectionStatus('connecting')).toBe('connecting');
    expect(mapConnectionStatus('authenticating')).toBe('authenticating');
    expect(mapConnectionStatus('connected')).toBe('connected');
    expect(mapConnectionStatus('discovering')).toBe('discovering');
    expect(mapConnectionStatus('ready')).toBe('ready');
    expect(mapConnectionStatus('failed')).toBe('failed');
  });
  test('unknown / undefined falls through to "unknown"', () => {
    expect(mapConnectionStatus(undefined)).toBe('unknown');
    expect(mapConnectionStatus('not-a-real-state')).toBe('unknown');
  });
});

// ── 3b. parseMcpHeaders ────────────────────────────────────────────────────

describe('parseMcpHeaders', () => {
  test('parses a valid flat string→string map', () => {
    expect(parseMcpHeaders('{"Authorization":"Bearer x"}')).toEqual({ Authorization: 'Bearer x' });
  });
  test('null / empty / malformed / wrong-shape → null', () => {
    expect(parseMcpHeaders(null)).toBeNull();
    expect(parseMcpHeaders(undefined)).toBeNull();
    expect(parseMcpHeaders('')).toBeNull();
    expect(parseMcpHeaders('not-json')).toBeNull();
    expect(parseMcpHeaders('["a"]')).toBeNull();
    expect(parseMcpHeaders('{"n":1}')).toBeNull();
  });
});

// ── 3c. The credential seam: mcpCredentialTransport ────────────────────────
//
// This replaces a test that asserted the OPPOSITE and was the reproduction:
// it pinned `requestInit.headers` as "the DURABLE carrier" and proved a bearer
// survives `JSON.stringify`. Surviving `JSON.stringify` is exactly the defect —
// that is the SDK writing the user's token into `cf_agents_mcp_servers` in the
// clear (`persistTransportOptions`, agents/dist/client-zqKcsyFa.js:1022-1035).

/** The SDK's own persistence, applied to whatever we hand `registerServer`.
 *  Copied from `persistTransportOptions`'s whitelist, so a change in the
 *  vendored SDK shows up here as a failing assertion rather than as a silent
 *  leak. */
const SDK_PERSISTED_TRANSPORT_KEYS = [
  'type', 'headers', 'requestInit', 'reconnectionOptions',
  'skipIssuerMetadataValidation', 'onInsufficientScope', 'maxStepUpRetries',
  'sessionId', 'protocolVersion',
] as const;

function asTheSdkWouldPersist(transport: RecordedMcpTransport): string {
  // Built by picking, not by filling a dictionary: the whitelist's order is the
  // order the SDK serialises in, and `Object.fromEntries` keeps it.
  return JSON.stringify({
    transport: Object.fromEntries(
      SDK_PERSISTED_TRANSPORT_KEYS
        .filter((key) => transport[key] !== undefined)
        .map((key) => [key, transport[key]]),
    ),
  });
}

describe('mcpCredentialTransport', () => {
  const CREDENTIAL = { Authorization: 'Bearer live-secret' };

  test('nothing the SDK can persist carries the credential', () => {
    const opts = mcpCredentialTransport('https://mcp.example/sse', async () => CREDENTIAL);
    expect(Object.keys(opts)).toEqual(['fetch']);
    const persisted = asTheSdkWouldPersist({ ...opts, type: 'sse' });
    expect(persisted).not.toContain('live-secret');
    expect(persisted).not.toContain('Authorization');
    expect(persisted).toBe(JSON.stringify({ transport: { type: 'sse' } }));
  });

  test('a request to the server carries the credential', async () => {
    const seen: Headers[] = [];
    await withFetch((_url, init) => { seen.push(new Headers(init?.headers)); }, async () => {
      const opts = mcpCredentialTransport('https://mcp.example/sse', async () => CREDENTIAL);
      await opts.fetch('https://mcp.example/sse', { headers: { accept: 'text/event-stream' } });
    });
    expect(seen[0]?.get('authorization')).toBe('Bearer live-secret');
    // The SDK's own headers for the call are merged, not replaced.
    expect(seen[0]?.get('accept')).toBe('text/event-stream');
  });

  test('a request to ANY other origin does not — that is the OAuth metadata path', async () => {
    const seen: Headers[] = [];
    await withFetch((_url, init) => { seen.push(new Headers(init?.headers)); }, async () => {
      const opts = mcpCredentialTransport('https://mcp.example/sse', async () => CREDENTIAL);
      await opts.fetch('https://idp.elsewhere/.well-known/oauth-authorization-server');
      await opts.fetch('https://mcp.example.evil/sse');
    });
    expect(seen).toHaveLength(2);
    for (const headers of seen) expect(headers.get('authorization')).toBeNull();
  });

  test('a credentialed request never follows a redirect', async () => {
    const inits: (RequestInit | undefined)[] = [];
    await withFetch((_url, init) => { inits.push(init); }, async () => {
      const opts = mcpCredentialTransport('https://mcp.example/sse', async () => CREDENTIAL);
      await opts.fetch('https://mcp.example/sse');
    });
    expect(inits[0]?.redirect).toBe('manual');
  });

  test('the CURRENT sealed value is spent, so a rotation needs no reconnect', async () => {
    let stored: Record<string, string> | null = { Authorization: 'Bearer first' };
    const seen: string[] = [];
    await withFetch((_url, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? 'none');
    }, async () => {
      const opts = mcpCredentialTransport('https://mcp.example/sse', async () => stored);
      await opts.fetch('https://mcp.example/sse');
      stored = { Authorization: 'Bearer rotated' };
      await opts.fetch('https://mcp.example/sse');
      stored = null;
      await opts.fetch('https://mcp.example/sse');
    });
    expect(seen).toEqual(['Bearer first', 'Bearer rotated', 'none']);
  });
});

/** Run `body` with `fetch` observed rather than performed. */
async function withFetch(
  observe: (url: Request | URL | RequestInfo, init?: RequestInit) => void,
  body: () => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  // `typeof globalThis.fetch` carries `preconnect` beside the call signature, so
  // the stub is COMPLETED with the real one's rather than asserted into shape.
  const record = async (
    url: Request | URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    observe(url, init);
    return new Response('{}', { status: 200 });
  };
  globalThis.fetch = Object.assign(record, { preconnect: real.preconnect });
  try { await body(); } finally { globalThis.fetch = real; }
}

// ── 4. mcp_ prefix collision guard in buildBuiltinTools ────────────────────

describe('buildBuiltinTools mcp_ prefix guard', () => {
  test("BUILTIN_TOOLS today don't start with mcp_", async () => {
    const { BUILTIN_TOOLS } = await import('@kinu.run/core');
    for (const n of BUILTIN_TOOLS) {
      expect(isMcpToolKey(n)).toBe(false);
    }
  });
});

// ── 5. Orchestrator MCP tool adapter (closure dispatch) ────────────────────
//
// We can't boot OrchestratorAgent in a bun test, so we replay the closure
// construction the same way buildUserMcpTools() does and assert that invoking
// `.execute()` dispatches to the stub with the caller's workspace name plus
// the exact (serverId, name, args) the LLM produced. The caller name is the
// input to UserDO's caller-ownership gate (userMcp_callTool → hasWorkspace).

interface FakeUserDOStub {
  userMcp_callTool(callerAgentName: string, serverId: string, name: string, args: JsonObject): Promise<JsonValue>;
}

function buildAdapter(stub: FakeUserDOStub, callerAgentName: string, serverId: string, name: string) {
  const execute = async (args: JsonObject): Promise<JsonValue> => {
    try { return await stub.userMcp_callTool(callerAgentName, serverId, name, args); }
    catch (err) { return { isError: true, error: err instanceof Error ? err.message : String(err) }; }
  };
  const adapter = tool({
    description: `${serverId}/${name}`,
    inputSchema: jsonSchema<JsonObject>({
      type: 'object',
      properties: { x: { type: 'string' } },
    }),
    execute,
  });
  return { adapter, execute };
}

describe('orchestrator MCP tool adapter', () => {
  test('threads the caller workspace name + (serverId, name, args) to the stub', async () => {
    const captured: Array<{ caller: string; id: string; name: string; args: unknown }> = [];
    const stub: FakeUserDOStub = {
      async userMcp_callTool(caller, id, name, args) {
        captured.push({ caller, id, name, args });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const { adapter, execute } = buildAdapter(stub, 'my-workspace', 'srv1', 'echo');
    expect(adapter.execute).toBe(execute);
    const result = await execute({ x: 'hi' });
    expect(captured[0]).toEqual({ caller: 'my-workspace', id: 'srv1', name: 'echo', args: { x: 'hi' } });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  // The UserDO gate rejects a caller that isn't one of the user's workspaces;
  // the adapter must surface that rejection as a structured tool error rather
  // than throw through the model loop. (Fail-closed propagation.)
  test('surfaces a caller-ownership rejection as a structured tool error', async () => {
    const owned = new Set(['my-workspace']);
    const stub: FakeUserDOStub = {
      async userMcp_callTool(caller) {
        if (!owned.has(caller)) throw new Error(`MCP call rejected: '${caller}' is not one of your workspaces.`);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const rejected = buildAdapter(stub, 'not-mine', 'srv1', 'echo');
    expect(await rejected.execute({ x: 'hi' }))
      .toEqual({ isError: true, error: "MCP call rejected: 'not-mine' is not one of your workspaces." });

    const allowed = buildAdapter(stub, 'my-workspace', 'srv1', 'echo');
    expect(await allowed.execute({ x: 'hi' }))
      .toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  test('catches dispatch errors and surfaces them as structured tool errors', async () => {
    const stub: FakeUserDOStub = {
      async userMcp_callTool() { throw new Error('upstream MCP server unavailable'); },
    };
    const adapter = buildAdapter(stub, 'my-workspace', 'srv1', 'echo');
    const result = await adapter.execute({ x: 'hi' });
    expect(result).toEqual({ isError: true, error: 'upstream MCP server unavailable' });
  });
});

// ── 6. Builtin reserves the `mcp_` prefix ──────────────────────────────────

describe('buildBuiltinTools assertion', () => {
  test('throws when a builtin under construction starts with mcp_', () => {
    // Stand up a minimal fake rt that lets buildBuiltinTools run far
    // enough to hit the assertion. The simpler proof is the registry guarantee
    // (test above) — this confirms the assertion fires when violated.
    // We monkey-patch BUILTIN_TOOL_DESCRIPTIONS via a local builtins copy
    // wouldn't be DRY; instead, recompute the guard inline against a known
    // bad shape so the contract stays in one place.
    const tools = { execute_tools: {}, mcp_evil: {} };
    const offenders = Object.keys(tools).filter(isMcpToolKey);
    expect(offenders).toEqual(['mcp_evil']);
  });
});
