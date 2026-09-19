/**
 * The Sandbox switch, as the owner reads it.
 *
 * The sandbox is one per-device setting: the switch itself is a
 * `role="switch"` whose `aria-checked` IS the tier, and the row carries one
 * label per mode. The badge is a machine fact the switch cannot change, so
 * it sits beside the switch rather than inside a sentence.
 *
 * And one thing the client must tolerate: a device row written before the
 * registry recorded a sandbox. It parses as the default — switch on,
 * capability unproven — rather than failing the whole listing.
 *
 * `renderToStaticMarkup` runs the components for real. No effects run and none
 * are needed: every line under test is derived from props.
 */
import './helpers/ui-module-globals';
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describeGpuNodes } from '@kinu.run/core';
import { DeviceRow } from '../src/components/devices/DeviceRow';
import { DEVICE_UPDATE_COPY } from '../src/hooks/use-device-roster';
import { DeviceConsentCard } from '../src/pages/WorkspacePage';
import { listDevices, type UserDevice } from '../src/lib/user-api';
import type { PendingConsent } from '@kinu.run/core';

const AT = Date.UTC(2026, 8, 1, 9, 0, 0);

function device(sandbox: UserDevice['sandbox'], label = 'workstation', update: Pick<UserDevice, 'version' | 'servedVersion' | 'update'> = CURRENT): UserDevice {
  return {
    id: 'dev-1', label, os: 'linux', hostname: 'pc', connected: true,
    createdAt: AT, lastSeenAt: AT, expiresAt: AT + 864e5,
    lastIp: null, lastAgent: null, replacedAt: null, revokedAt: null, unstoppedAt: null,
    sandbox,
    ...update,
  };
}

const SERVED = '0.3.0+served';

const CURRENT = { version: SERVED, servedVersion: SERVED, update: 'current' } as const;

/** What a reader sees: the markup with its entity escapes resolved, so every
 *  assertion below can quote the product's own words. */
function readable(markup: string): string {
  return markup
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

function renderRow(sandbox: UserDevice['sandbox'], update?: Pick<UserDevice, 'version' | 'servedVersion' | 'update'>): string {
  return readable(renderToStaticMarkup(createElement(DeviceRow, {
    device: device(sandbox, 'workstation', update),
    grants: [],
    onDeviceChanged: () => {},
    onGrantsChanged: () => {},
    onError: () => {},
    onRevoke: () => {},
    unstoppedCommands: undefined,
    onAcknowledge: async () => {},
  })));
}

/** The switch's own state, read off the one `role="switch"` in the row. */
function switchState(markup: string) {
  const switches = [...markup.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((match) => match[0]);
  const checked = switches[0]?.match(/aria-checked="(true|false)"/)?.[1] ?? null;

  return { count: switches.length, checked };
}

describe('the device row labels the switch state', () => {
  test('sandbox on: the switch checked, the Sandboxed label, the GPU line', () => {
    const html = renderRow({ tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: ['/dev/nvidia0'] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'true' });
    expect(html).toContain('data-sandbox-mode="sandboxed"');
    expect(html).toContain('Sandboxed.');
    expect(html).toContain(`GPU: ${describeGpuNodes(['/dev/nvidia0'])}`);
  });

  test('sandbox off: the switch unchecked, the Off label, no GPU line', () => {
    const html = renderRow({ tier: 'raw', capability: 'sandboxed', reason: null, detail: null, gpu: ['/dev/nvidia0'] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'false' });
    expect(html).toContain('data-sandbox-mode="raw"');
    expect(html).toContain('Off.');
    expect(html).not.toContain('GPU:');
  });

  test('a machine without a GPU says so, measured rather than omitted', () => {
    const html = renderRow({ tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: [] });
    expect(html).toContain('GPU: none');
  });
});

describe('a machine that cannot sandbox carries the badge, never an explanation', () => {
  test('switch on, no bwrap: the badge, the Files only label, no GPU line', () => {
    const html = renderRow({ tier: 'sandboxed', capability: 'files_only', reason: 'no_bwrap', detail: null, gpu: [] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'true' });
    expect(html).toContain('data-sandbox-mode="files_only"');
    expect(html).toContain('Cannot sandbox');
    expect(html).toContain('Files only.');
    expect(html).not.toContain('GPU:');
  });

  test('switch off on such a machine: the badge stays — it is a fact about the machine', () => {
    const html = renderRow({ tier: 'raw', capability: 'raw_only', reason: 'unsupported_platform', detail: null, gpu: [] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'false' });
    expect(html).toContain('data-sandbox-mode="raw"');
    expect(html).toContain('Cannot sandbox');
  });
});

describe('the bind card asks one question and offers one binding', () => {
  const consent: PendingConsent = {
    consentId: 'c1', deviceLabel: 'ashish-device', method: 'exec',
    command: 'bun test packages/core', createdAt: AT, workspaceName: 'checkout-fixes',
  };

  function card(): string {
    return readable(renderToStaticMarkup(createElement(DeviceConsentCard, { consent, onResolve: () => {} })));
  }

  test('the question names the machine and the workspace', () => {
    expect(card().replace(/<[^>]+>/g, '')).toContain('Use ashish-device for “checkout-fixes”?');
  });

  test('exactly one binding button, named for the machine, beside "Not now"', () => {
    const buttons = [...card().matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
    expect(buttons).toEqual(['Not now', 'Use ashish-device']);
  });

  test('no tier wording and no one-off allowance survive on the card', () => {
    const html = card();

    for (const gone of ['Allow once', 'Grant', 'full filesystem', 'full access', 'connected folder', 'shell access', 'Deny']) {
      expect(html).not.toContain(gone);
    }

    expect(html).toContain("Commands use ashish-device's Sandbox setting");
    expect(html).toContain('Account settings → Devices');
  });
});

/** The update badge: the one `role="status"` in the row, read by its data
 *  attribute and its text. */
function updateBadge(markup: string): { state: string; text: string } | null {
  const match = markup.match(/<span role="status" data-device-update="([a-z]+)"[^>]*>([^<]*)<\/span>/);

  return match ? { state: match[1] ?? '', text: match[2] ?? '' } : null;
}

describe('the device row shows the machine\'s software state beside its link state', () => {
  const sandboxed = { tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: [] } as const;

  test('behind the served build: a badge with the update-available copy', () => {
    const html = renderRow(sandboxed, { version: '0.2.0+older', servedVersion: SERVED, update: 'behind' });
    expect(updateBadge(html)).toEqual({ state: 'behind', text: DEVICE_UPDATE_COPY.behind });
    // Beside the connected badge, not a new row: both sit in the header line.
    const header = html.slice(0, html.indexOf('role="switch"'));
    expect(header).toContain('>connected<');
    expect(header).toContain('data-device-update="behind"');
  });

  test('opted out: a badge with the update-off copy', () => {
    const html = renderRow(sandboxed, { version: '0.2.0+older', servedVersion: SERVED, update: 'off' });
    expect(updateBadge(html)).toEqual({ state: 'off', text: DEVICE_UPDATE_COPY.off });
  });

  test('current, and a daemon that named no build: no badge', () => {
    expect(updateBadge(renderRow(sandboxed))).toBeNull();
    expect(updateBadge(renderRow(sandboxed, { version: null, servedVersion: SERVED, update: 'unreported' }))).toBeNull();
  });
});

describe('a device row written before the registry recorded a sandbox', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('parses as switch-on, capability unproven, rather than failing the listing', async () => {
    const withoutSandbox = {
      id: 'dev-old', label: 'old', os: 'linux', hostname: 'old', connected: false,
      createdAt: AT, lastSeenAt: null, expiresAt: null,
      lastIp: null, lastAgent: null, replacedAt: null, revokedAt: null, unstoppedAt: null,
    };

    const withSandbox = { ...withoutSandbox, id: 'dev-new', sandbox: { tier: 'raw', capability: 'sandboxed', reason: null, gpu: [] } };
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify([withoutSandbox, withSandbox]), { headers: { 'content-type': 'application/json' } }),
      { preconnect: realFetch.preconnect },
    );
    const devices = await listDevices();
    // `withSandbox` carries no `detail`: a hub that does not send the field
    // lists as having said nothing beyond the reason.
    expect(devices.map((row) => row.sandbox)).toEqual([
      { tier: 'sandboxed', capability: 'files_only', reason: null, detail: null, gpu: [] },
      { tier: 'raw', capability: 'sandboxed', reason: null, detail: null, gpu: [] },
    ]);
    // Nor a software state: such a row lists as a daemon that named no build.
    expect(devices.map((row) => row.update)).toEqual(['unreported', 'unreported']);
  });
});
