/**
 * The Sandbox switch, as the owner reads it.
 *
 * The sandbox is one per-device setting with one line of copy per state, and
 * the copy is the owner's own words — so the words are what this file pins.
 * Three things the row must get right, and one the bind card must:
 *
 *   - ON says what a sandbox is; OFF says the agent runs as the owner. The
 *     switch itself is a `role="switch"` whose `aria-checked` IS the tier.
 *   - A machine that cannot sandbox is never quietly run unconfined. With the
 *     switch on it runs no commands, and the row says so — with the fix core
 *     documents for that reason, not a paraphrase.
 *   - The GPU line rides the sandboxed row only: it describes what the sandbox
 *     passes through, which is meaningless when nothing is confined.
 *   - The bind card asks ONE question and offers one binding button. No tier
 *     wording survives on it: a binding is yes/no, and what a command may reach
 *     is the machine's own switch.
 *
 * And one thing the client must tolerate: a device row written before the
 * registry recorded a sandbox. It parses as the default — switch on, capability
 * unproven — rather than failing the whole listing.
 *
 * `renderToStaticMarkup` runs the components for real. No effects run and none
 * are needed: every line under test is derived from props.
 */
import './helpers/ui-module-globals';
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describeGpuNodes, sandboxReasonFix } from '@kinu.run/core';
import { DeviceRow } from '../src/pages/UserSettingsPage';
import { DeviceConsentCard } from '../src/pages/WorkspacePage';
import { listDevices, type UserDevice } from '../src/lib/user-api';
import type { PendingConsent } from '../src/lib/protocol';

const AT = Date.UTC(2026, 8, 1, 9, 0, 0);

const SANDBOXED_COPY =
  'Commands can use the agent home, selected folders, GPU, and network. Other files stay hidden.';
const RAW_COPY = 'Off. The agent runs as you with full access.';
const CANNOT_COPY = 'No sandbox. Nothing runs here.';

function device(sandbox: UserDevice['sandbox'], label = 'workstation'): UserDevice {
  return {
    id: 'dev-1', label, os: 'linux', hostname: 'pc', connected: true,
    createdAt: AT, lastSeenAt: AT, expiresAt: AT + 864e5,
    lastIp: null, lastAgent: null, replacedAt: null, revokedAt: null, unstoppedAt: null,
    sandbox,
  };
}

/** What a reader sees: the markup with its entity escapes resolved, so every
 *  assertion below can quote the product's own words. */
function readable(markup: string): string {
  return markup
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

function renderRow(sandbox: UserDevice['sandbox']): string {
  return readable(renderToStaticMarkup(createElement(DeviceRow, {
    device: device(sandbox),
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

/** The fix as a reader sees it: core writes its commands in backticks for the
 *  CLI, and the row renders those as `<code>`, so the words are compared with
 *  tags dropped and backticks gone. */
function visibleFix(markup: string, fix: string): boolean {
  return markup.replace(/<[^>]+>/g, '').includes(fix.replaceAll('`', ''));
}

describe('the device row explains the switch in one line per state', () => {
  test('sandbox on, on a machine that can sandbox: the ON copy, the switch checked, the GPU line', () => {
    const html = renderRow({ tier: 'sandboxed', capability: 'sandboxed', reason: null, gpu: ['/dev/nvidia0'] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'true' });
    expect(html).toContain('data-sandbox-mode="sandboxed"');
    expect(html).toContain(SANDBOXED_COPY);
    expect(html).toContain(`GPU: ${describeGpuNodes(['/dev/nvidia0'])}`);
    expect(html).not.toContain(RAW_COPY);
    expect(html).not.toContain(CANNOT_COPY);
    expect(html).not.toContain('Cannot sandbox');
  });

  test('sandbox off: the OFF copy, the switch unchecked, no GPU line', () => {
    const html = renderRow({ tier: 'raw', capability: 'sandboxed', reason: null, gpu: ['/dev/nvidia0'] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'false' });
    expect(html).toContain('data-sandbox-mode="raw"');
    expect(html).toContain(RAW_COPY);
    expect(html).not.toContain(SANDBOXED_COPY);
    expect(html).not.toContain('GPU:');
  });

  test('a machine without a GPU says so, measured rather than omitted', () => {
    const html = renderRow({ tier: 'sandboxed', capability: 'sandboxed', reason: null, gpu: [] });
    expect(html).toContain('GPU: none');
  });
});

describe('a machine that cannot sandbox is never quietly run unconfined', () => {
  test('switch on, no bwrap: no commands run, and the fix core documents for that reason', () => {
    const html = renderRow({ tier: 'sandboxed', capability: 'files_only', reason: 'no_bwrap', gpu: [] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'true' });
    expect(html).toContain('data-sandbox-mode="files_only"');
    expect(html).toContain('Cannot sandbox');
    expect(html).toContain(CANNOT_COPY);
    expect(visibleFix(html, sandboxReasonFix('no_bwrap'))).toBe(true);
    expect(html).toContain('<code class="font-mono">sudo apt install bubblewrap</code>');
    // The ON copy promises a sandbox this machine cannot provide.
    expect(html).not.toContain(SANDBOXED_COPY);
    expect(html).not.toContain('GPU:');
  });

  test('a daemon that named no reason gets the honest sentence, not an invented cause', () => {
    const html = renderRow({ tier: 'sandboxed', capability: 'files_only', reason: null, gpu: [] });
    expect(html).toContain(CANNOT_COPY);
    expect(visibleFix(html, sandboxReasonFix(null))).toBe(true);
  });

  test('switch off on such a machine: the OFF copy, and the badge and fix stay — they are facts about the machine', () => {
    const html = renderRow({ tier: 'raw', capability: 'raw_only', reason: 'unsupported_platform', gpu: [] });
    expect(switchState(html)).toEqual({ count: 1, checked: 'false' });
    expect(html).toContain('data-sandbox-mode="raw"');
    expect(html).toContain(RAW_COPY);
    expect(html).toContain('Cannot sandbox');
    expect(visibleFix(html, sandboxReasonFix('unsupported_platform'))).toBe(true);
    expect(html).not.toContain(CANNOT_COPY);
  });
});

describe('the bind card asks one question and offers one binding', () => {
  const consent: PendingConsent = {
    consentId: 'c1', deviceLabel: 'ashish-laptop', method: 'exec',
    command: 'bun test packages/core', createdAt: AT, workspaceName: 'checkout-fixes',
  };
  const html = readable(renderToStaticMarkup(createElement(DeviceConsentCard, { consent, onResolve: () => {} })));

  test('the question names the machine and the workspace', () => {
    expect(html.replace(/<[^>]+>/g, '')).toContain('Use ashish-laptop for “checkout-fixes”?');
  });

  test('exactly one binding button, named for the machine, beside "Not now"', () => {
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
    expect(buttons).toEqual(['Not now', 'Use ashish-laptop']);
  });

  test('no tier wording and no one-off allowance survive on the card', () => {
    for (const gone of ['Allow once', 'Grant', 'full filesystem', 'full access', 'connected folder', 'shell access', 'Deny']) {
      expect(html).not.toContain(gone);
    }
    expect(html).toContain("Commands use ashish-laptop's Sandbox setting");
    expect(html).toContain('Account settings → Devices');
  });
});

describe('a device row written before the registry recorded a sandbox', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('parses as switch-on, capability unproven, rather than failing the listing', async () => {
    const legacy = {
      id: 'dev-old', label: 'old', os: 'linux', hostname: 'old', connected: false,
      createdAt: AT, lastSeenAt: null, expiresAt: null,
      lastIp: null, lastAgent: null, replacedAt: null, revokedAt: null, unstoppedAt: null,
    };
    const modern = { ...legacy, id: 'dev-new', sandbox: { tier: 'raw', capability: 'sandboxed', reason: null, gpu: [] } };
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify([legacy, modern]), { headers: { 'content-type': 'application/json' } }),
      { preconnect: realFetch.preconnect },
    );
    const devices = await listDevices();
    expect(devices.map((row) => row.sandbox)).toEqual([
      { tier: 'sandboxed', capability: 'files_only', reason: null, gpu: [] },
      { tier: 'raw', capability: 'sandboxed', reason: null, gpu: [] },
    ]);
  });
});
