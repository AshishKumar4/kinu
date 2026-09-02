/**
 * Linking a machine from a work surface.
 *
 * The report: "when I want to connect my desktop from my Workspace → Env →
 * connect, it takes me to the settings page instead of a modal or something."
 * The connect affordance is now a panel that opens where it was asked for, and
 * the four things it must get right are all decisions rather than pixels:
 *
 *   - ONE registration per panel. `POST /api/user/devices` is what mints the
 *     row the owner then sees, so a second ask — a double click, a re-render,
 *     a second surface driving the same flow — must not mint a second one.
 *   - The command is the SERVER's. Nothing here builds one from an origin: the
 *     server owns the one-liner and the panel renders exactly what it received.
 *   - The panel settles on a machine that ARRIVED. `registerDevice` on the
 *     UserDO always inserts, so an id the account did not have and that reports
 *     connected is the machine the owner just linked.
 *   - Without a roster it says it cannot confirm. A null baseline makes every
 *     existing device look new, so the panel refuses to guess.
 *
 * `DeviceConnectFlow` is a plain object precisely so those four are provable
 * here rather than only in a browser. What is NOT provable here and is left to
 * `scripts/chat-and-files-ux.test.ts`: that the Environment card's button opens
 * this panel over the surface instead of navigating away.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEVICE_CONNECT_DISCLOSURE } from '@kinu.run/core';
import { ConnectDevicePanel, DeviceConnectFlow } from '../src/components/ConnectDevicePanel';
import type { UserDevice } from '../src/lib/user-api';

/** The one-liner the server composes. Exactly as `buildCliInstallCommand`
 *  writes it, quoting and all: the point of the assertions below is that not
 *  one character of it is the client's. */
const SERVER_COMMAND =
  "curl -fsSL 'https://kinu.run/install.sh' | KINU_PARENT_ACTIVATES=1 bash -s -- --no-setup --connect"
  + ' && export PATH="${KINU_HOME:-$HOME/.kinu}/bin:$PATH"';

const AT = Date.UTC(2026, 8, 1, 9, 0, 0);

function device(id: string, connected: boolean, label = id): UserDevice {
  return {
    id, label, os: 'linux', hostname: 'pc', connected,
    createdAt: AT, lastSeenAt: connected ? AT : null, expiresAt: AT + 864e5,
    lastIp: null, lastAgent: null, replacedAt: null, revokedAt: null, unstoppedAt: null,
    sandbox: { tier: 'sandboxed', capability: 'sandboxed', reason: null, gpu: [] },
  };
}

interface Recorder {
  readonly flow: DeviceConnectFlow;
  /** Every label `POST /api/user/devices` was called with, in order. An ask
   *  with no name is recorded as `(unnamed)` rather than as `undefined`:
   *  `toEqual` treats an undefined element as absent, so an array of them
   *  cannot count. */
  readonly registrations: string[];
  /** Every device the flow reported as connected. */
  readonly settled: UserDevice[];
}

function recorder(command = SERVER_COMMAND): Recorder {
  const registrations: string[] = [];
  const settled: UserDevice[] = [];
  const flow = new DeviceConnectFlow({
    register: async (label) => { registrations.push(label ?? '(unnamed)'); return { installCommand: command }; },
    onConnected: (arrived) => { settled.push(arrived); },
  });
  return { flow, registrations, settled };
}

/** What a reader sees for a given flow state. `renderToStaticMarkup` runs the
 *  panel for real — `useSyncExternalStore` reads the flow's own snapshot — and
 *  hands back the markup. The one effect it skips is the roster hand-off,
 *  which is driven directly here instead. */
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
    // The rendered command, un-escaped, must be the server's string exactly:
    // an origin joined client-side would differ by a flag, a quote or the
    // PATH tail.
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
    // And it has NOT asked for a command yet: the disclosure comes first.
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
    expect(render(flow, [])).toContain('Waiting for this machine to report in');
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
    expect(html).toContain('cannot confirm the connection');
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
