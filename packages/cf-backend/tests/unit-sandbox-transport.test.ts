/**
 * Defends: the sandbox executor's Workers Logs line naming a transport its client never used. It said
 * `websocket` while the client ran over rpc, so a disconnect was diagnosed against the wrong transport.
 * Both halves are observed: the options the Sandbox SDK receives, and the line the console logger writes.
 * Product code opens no sandbox but through `openSandbox` (`no-restricted-imports` in `.oxlintrc.json`), and
 * the release-config gate holds the deployed default to the same transport.
 */
import { afterAll, expect, spyOn, test } from 'bun:test';
import type { SandboxOptions } from '@cloudflare/sandbox';
import * as v from 'valibot';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { installSandboxSdkMock, setSandboxSdk } from './helpers/sandbox-sdk';

mockAgentsSdk();

const opened: (SandboxOptions | undefined)[] = [];

// Reset in `afterAll`, so a later file meets the real SDK.
await installSandboxSdkMock();

setSandboxSdk({
  getSandbox: (_ns: NonNullable<Env['Sandbox']>, _id: string, options?: SandboxOptions) => {
    opened.push(options);

    // Registering adapts the client and calls nothing on it; a call would need a container this test has not.
    return new Proxy({}, {
      get: (_target, member) => {
        throw new Error(`no container behind this sandbox client: ${String(member)} was called`);
      },
    });
  },
});

afterAll(() => { setSandboxSdk(null); });

// Must follow the sandbox double: the harness's module graph reaches the sandbox SDK.
const { orchestratorHarness } = await import('./helpers/actor-harness');

/** A Workers Logs line as the console logger writes it, narrowed to the field read here. */
const LogLineSchema = v.pipe(v.string(), v.parseJson(), v.object({
  event: v.string(),
  fields: v.optional(v.looseObject({ transport: v.optional(v.string()) })),
}));

test('the executor opens its client over rpc, and its log line names that transport', () => {
  // The actor installs its console sink when it is constructed, so the line is read where Workers Logs reads it.
  const consoleError = spyOn(console, 'error');
  let lines: unknown[];

  try {
    orchestratorHarness(undefined, { container: true });
    lines = consoleError.mock.calls.map(([line]) => line);
  } finally {
    consoleError.mockRestore();
  }

  const registered = lines.flatMap((line) => {
    const parsed = v.safeParse(LogLineSchema, line);

    return parsed.success && parsed.output.event === 'sandbox.executor_registered' ? [parsed.output] : [];
  });

  // The route-based client (`http`/`websocket`) fails restores at 12 MiB and above on a real 0.12.7
  // container (`sandbox.route_client.restore_bytes`); changing the transport is an owner decision.
  expect(opened.map((options) => options?.transport)).toEqual(['rpc']);
  expect(registered.map((line) => line.fields?.transport)).toEqual(['rpc']);
});
