// Defends: a holder of the CodexEgress binding reaches only forward, cancel and alarm.
import { env } from 'cloudflare:test';
import type { HostileStart } from './codex-egress-records';
import { describe, expect, test } from 'vitest';

const stubFor = (name: string) => {
  const ns = env.CODEX_EGRESS_PROBE;

  if (ns === undefined) throw new Error('test runner did not bind CODEX_EGRESS_PROBE (vitest.config.ts)');

  return ns.get(ns.idFromName(name));
};

async function refusal(call: () => Promise<void | Response>): Promise<string> {
  try {
    await call();

    return 'answered';
  } catch (error) {
    return String(error);
  }
}

describe('what RPC reaches on CodexEgress', () => {
  test('the base Container\'s start and outbound methods are refused on a real stub, and nothing starts', async () => {
    const stub = stubFor('hostile');
    const hostile: HostileStart = { entrypoint: ['sh', '-c', 'id'], envVars: { NODE_OPTIONS: '--require /tmp/x' } };

    const holder = stub;

    const answers = await Promise.all([
      refusal(() => holder.doStartContainer({ retries: 1, waitInterval: 1 }, hostile)),
      refusal(() => holder.startContainerIfNotRunning({ retries: 1, waitInterval: 1 }, hostile)),
      refusal(() => holder.start(hostile)),
      refusal(() => holder.startAndWaitForPorts({ ports: 8080, startOptions: hostile })),
      refusal(() => holder.persistOutboundConfiguration({ outboundByHostOverrides: { 'evil.example': { method: 'h' } } })),
      refusal(() => holder.setAllowedHosts(['evil.example'])),
      refusal(() => holder.containerFetch('http://x/')),
    ]);

    for (const answer of answers) expect(answer).toContain('does not implement the method');

    expect(await env.CODEX_EGRESS_RECORDS.read(stub.id.toString())).toEqual({ starts: [] });
  });

  test('a forward starts the image\'s own command, with no entrypoint or env', async () => {
    const stub = stubFor('forward');
    const request = new Request('https://chatgpt.com/backend-api/codex/models?client_version=1.0.0');

    const answer = await stub.forward('forward', 'call-1', request);

    // The recorder's container exits, so the box's start fails and the call is refused as a start failure, once.
    expect({ status: answer.status, refusal: answer.headers.get('x-kinu-egress-refusal') }).toEqual({ status: 503, refusal: 'start' });

    const records = await env.CODEX_EGRESS_RECORDS.read(stub.id.toString());

    expect(records.starts.length).toBeGreaterThan(0);
    expect(records.starts.every((start) => start.entrypoint === undefined && start.env === undefined)).toBe(true);
  });
});
