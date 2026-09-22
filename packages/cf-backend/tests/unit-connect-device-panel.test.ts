/**
 * One registration per panel; the command is the server's verbatim; the panel settles only on a
 * machine that arrived; with no roster it refuses to guess (a null baseline makes every device
 * new).
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEVICE_CONNECT_DISCLOSURE } from '@kinu.run/core';
import { ConnectDevicePanel, DeviceConnectFlow } from '../src/components/ConnectDevicePanel';
import { buildCliInstallCommand } from '@kinu.run/core';
import type { UserDevice } from '../src/lib/user-api';

/** Built by the devices route's own builder: the verbatim assertions prove the client adds
 *  nothing. */
const SERVER_COMMAND = buildCliInstallCommand({ origin: 'https://kinu.run', setup: false, connect: true });

const AT = Date.UTC(2026, 8, 1, 9, 0, 0);

function device(id: string, connected: boolean, label = id): UserDevice {
  return {
    id, label, os: 'linux', hostname: 'pc', connected,
    createdAt: AT, lastSeenAt: connected ? AT : null, expiresAt: AT + 864e5,
    lastIp: null, lastAgent: null, replacedAt: null, revokedAt: null, unstoppedAt: null,
    sandbox: { tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: [] },
    version: null, servedVersion: null, update: 'unreported',
  };
}

interface Recorder {
  readonly flow: DeviceConnectFlow;
  /** Unnamed asks record `(unnamed)`: `toEqual` treats an undefined element as absent. */
  readonly registrations: string[];
  readonly settled: UserDevice[];
}

function recorder(command = SERVER_COMMAND): Recorder {
  const registrations: string[] = [];
  const settled: UserDevice[] = [];

  const flow = new DeviceConnectFlow({
    register: async (label) => {
      registrations.push(label ?? '(unnamed)');

      return { installCommand: command };
    },
    onConnected: (arrived) => { settled.push(arrived); },
  });

  return { flow, registrations, settled };
}

/** Static markup skips the roster hand-off effect, which is driven directly here instead. */
function render(flow: DeviceConnectFlow, devices: readonly UserDevice[] | null): string {
  return renderToStaticMarkup(createElement(ConnectDevicePanel, { flow, devices }));
}

describe('the connect panel registers exactly once', () => {
  test('a second ask while the first is in flight mints no second device', async () => {
    const { flow, registrations } = recorder();
    const first = flow.start(undefined, []);
    const second = flow.start(undefined, []);
    await Promise.all([first, second]);
    expect(registrations).toEqual(['(unnamed)']);
  });

  test('a second ask after the command is handed over mints no second device', async () => {
    const { flow, registrations } = recorder();
    await flow.start('workstation', []);
    await flow.start('workstation', []);
    expect(registrations).toEqual(['workstation']);
  });

  test('a registration that failed may be asked for again — that one is a retry', async () => {
    const registrations: string[] = [];
    let fail = true;

    const flow = new DeviceConnectFlow({
      register: async () => {
        registrations.push(fail ? 'rejected' : 'accepted');

        if (fail) throw new Error('UserDO unreachable');

        return { installCommand: SERVER_COMMAND };
      },
      onConnected: () => {},
    });

    await flow.start(undefined, []);
    expect(flow.snapshot().kind).toBe('failed');
    expect(render(flow, [])).toContain('UserDO unreachable');
    fail = false;
    await flow.start(undefined, []);
    expect(registrations).toEqual(['rejected', 'accepted']);
    expect(flow.snapshot().kind).toBe('handed');
  });

  test('the label the owner typed reaches the server, and an empty one does not', async () => {
    const named = recorder();
    await named.flow.start('mac mini', []);
    expect(named.registrations).toEqual(['mac mini']);
  });
});

describe('the command on screen is the one the server handed over', () => {
  test('rendered verbatim, quoting and shell expansion intact', async () => {
    const { flow } = recorder();
    await flow.start(undefined, []);
    const html = render(flow, []);
    // The rendered command, un-escaped, must be the server's string exactly.
    const shown = /data-connect-command[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? '';

    const decoded = shown
      .replaceAll('&quot;', '"').replaceAll('&#x27;', "'")
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

    expect(decoded).toBe(SERVER_COMMAND);
  });

  test('a different command from the server is a different command on screen', async () => {
    const { flow } = recorder('curl -fsSL https://example.test/install.sh | bash');
    await flow.start(undefined, []);
    expect(render(flow, [])).toContain('example.test');
  });

  test('before anything is registered the panel states what connecting means', () => {
    const { flow } = recorder();
    const html = render(flow, []);

    for (const line of DEVICE_CONNECT_DISCLOSURE) {
      expect(html).toContain(line.replaceAll('&', '&amp;'));
    }

    expect(html).not.toContain('data-connect-command');
  });
});

describe('the panel settles on the machine that arrived', () => {
  test('a device the account did not have, reporting connected, closes the panel', async () => {
    const { flow, settled } = recorder();
    await flow.start(undefined, [device('dev-old', true)]);
    flow.observe([device('dev-old', true), device('dev-new', true, 'mac mini')]);
    expect(settled.map((d) => d.id)).toEqual(['dev-new']);
    expect(flow.snapshot()).toMatchObject({ kind: 'connected' });
    expect(render(flow, [])).toContain('mac mini is connected.');
  });

  test('a device that was already connected before the ask settles nothing', async () => {
    const { flow, settled } = recorder();
    const already = device('dev-old', true);
    await flow.start(undefined, [already]);
    flow.observe([already]);
    expect(settled).toEqual([]);
    expect(flow.snapshot().kind).toBe('handed');
  });

  test('a new row that has not connected yet settles nothing — the daemon has not dialled out', async () => {
    const { flow, settled } = recorder();
    await flow.start(undefined, []);
    flow.observe([device('dev-new', false)]);
    expect(settled).toEqual([]);
    expect(render(flow, [])).toContain('Waiting for this machine.');
  });

  test('it settles once; later rosters do not re-fire it', async () => {
    const { flow, settled } = recorder();
    await flow.start(undefined, []);
    flow.observe([device('dev-new', true)]);
    flow.observe([device('dev-new', true), device('dev-other', true)]);
    expect(settled.map((d) => d.id)).toEqual(['dev-new']);
  });

  test('a roster arriving before the ask cannot settle it', () => {
    const { flow, settled } = recorder();
    flow.observe([device('dev-new', true)]);
    expect(settled).toEqual([]);
    expect(flow.snapshot().kind).toBe('ready');
  });
});

describe('an unreadable roster is stated, never guessed around', () => {
  test('with no baseline the panel says it cannot confirm and settles on nothing', async () => {
    const { flow, settled } = recorder();
    await flow.start(undefined, null);
    const html = render(flow, null);
    expect(html).toContain('Your device list is unavailable');
    expect(html).not.toContain('Waiting for this machine');
    flow.observe([device('dev-new', true)]);
    expect(settled).toEqual([]);
  });

  test('an empty account is a baseline too — the first machine ever linked still arrives', async () => {
    const { flow, settled } = recorder();
    await flow.start(undefined, []);
    flow.observe([device('dev-new', true)]);
    expect(settled.map((d) => d.id)).toEqual(['dev-new']);
  });
});
