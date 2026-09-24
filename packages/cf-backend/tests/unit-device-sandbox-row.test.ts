/**
 * The Sandbox switch: `aria-checked` is the tier; the badge is a machine fact beside it. A device row written before the
 * registry recorded a sandbox must parse as the default rather than fail the listing.
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
    reuseDetectedAt: null, wholeMachine: false,
    sandbox,
    ...update,
  };
}

const SERVED = '0.3.0+served';

const CURRENT = { version: SERVED, servedVersion: SERVED, update: 'current' } as const;

/** Entity escapes resolved, so assertions quote the product's own words. */
function readable(markup: string): string {
  return markup
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

function renderRow(
  sandbox: UserDevice['sandbox'],
  update?: Pick<UserDevice, 'version' | 'servedVersion' | 'update'>,
  overrides: Partial<UserDevice> = {},
): string {
  return readable(renderToStaticMarkup(createElement(DeviceRow, {
    device: { ...device(sandbox, 'workstation', update), ...overrides },
    grants: [],
    onDeviceChanged: () => {},
    onGrantsChanged: () => {},
    onError: () => {},
    onRevoke: () => {},
    unstoppedCommands: undefined,
    onAcknowledge: async () => {},
  })));
}

function switchState(markup: string) {
  const switches = [...markup.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((match) => match[0]);
  const checked = switches[0]?.match(/aria-checked="(true|false)"/)?.[1] ?? null;

  return { count: switches.length, checked, disabled: switches[0]?.includes('disabled=""') ?? false };
}

describe('the device row labels the switch state', () => {
  test('sandbox on: the switch checked, the Sandboxed label, the GPU line', () => {
    const html = renderRow({ tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: ['/dev/nvidia0'] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'true', disabled: false });
    expect(html).toContain('data-sandbox-mode="sandboxed"');
    expect(html).toContain('Sandboxed.');
    expect(html).toContain(`GPU: ${describeGpuNodes(['/dev/nvidia0'])}`);
  });

  test('sandbox off: the switch unchecked, the Off label, no GPU line', () => {
    const html = renderRow({ tier: 'raw', capability: 'sandboxed', reason: null, detail: null, gpu: ['/dev/nvidia0'] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'false', disabled: false });
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
    expect(switchState(html)).toEqual({ count: 1, checked: 'true', disabled: false });
    expect(html).toContain('data-sandbox-mode="files_only"');
    expect(html).toContain('Cannot sandbox');
    expect(html).toContain('Files only.');
    expect(html).not.toContain('GPU:');
  });

  test('switch off on such a machine: the badge stays — it is a fact about the machine', () => {
    const html = renderRow({ tier: 'raw', capability: 'raw_only', reason: 'unsupported_platform', detail: null, gpu: [] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'false', disabled: false });
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
    expect(html).toContain('Revoke access on the Devices page');
  });
});

function updateBadge(markup: string): { state: string; text: string } | null {
  const match = markup.match(/<span role="status" data-device-update="([a-z]+)"[^>]*>([^<]*)<\/span>/);

  return match ? { state: match[1] ?? '', text: match[2] ?? '' } : null;
}

describe('the device row shows the machine\'s software state beside its link state', () => {
  const sandboxed = { tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: [] } as const;

  test('behind the served build: a badge with the update-available copy', () => {
    const html = renderRow(sandboxed, { version: '0.2.0+older', servedVersion: SERVED, update: 'behind' });
    expect(updateBadge(html)).toEqual({ state: 'behind', text: DEVICE_UPDATE_COPY.behind });
    // Beside the connected badge, in the header line, not a new row.
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

describe('a device linked from / says the agent has the whole machine', () => {
  test('the plain sentence, the raw mode, and a switch that cannot pretend otherwise', () => {
    const html = renderRow(
      { tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: [] }, undefined, { wholeMachine: true },
    );

    expect(html).toContain('the agent has this whole machine');
    expect(html).toContain('data-sandbox-mode="raw"');
    expect(html).not.toContain('Sandboxed.');
    expect(switchState(html)).toMatchObject({ count: 1, disabled: true });
  });
});

describe('a revoked device names why it was revoked', () => {
  const sandboxed = { tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: [] } as const;

  test('a key used from two places: that, and no claim about commands', () => {
    const html = renderRow(sandboxed, undefined, { revokedAt: AT, reuseDetectedAt: AT });

    expect(html).toContain('its key was used after it had been replaced');
    expect(html).toContain('Run kinu connect on the machine you trust');
    expect(html).not.toContain('could not confirm that every command stopped');
  });

  test('an unconfirmed command: that, and no claim about the key', () => {
    const html = renderRow(sandboxed, undefined, { revokedAt: AT, unstoppedAt: AT });

    expect(html).toContain('could not confirm that every command stopped');
    expect(html).not.toContain('its key was used');
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
    // A hub that omits `detail` lists as having said nothing beyond the reason.
    expect(devices.map((row) => row.sandbox)).toEqual([
      { tier: 'sandboxed', capability: 'files_only', reason: null, detail: null, gpu: [] },
      { tier: 'raw', capability: 'sandboxed', reason: null, detail: null, gpu: [] },
    ]);
    expect(devices.map((row) => row.update)).toEqual(['unreported', 'unreported']);
    // A hub from before these fields read as no incident and a confined link.
    expect(devices.map((row) => [row.reuseDetectedAt, row.wholeMachine])).toEqual([[null, false], [null, false]]);
  });
});
