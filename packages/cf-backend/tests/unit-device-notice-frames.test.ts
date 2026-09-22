/**
 * Offline-notice socket frames (produced by the UserDO fan-out, see unit-device-grants): the wire shape
 * useKinu's listener accepts, and what DeviceOfflineRow shows for one machine, several, or none.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { DeviceOfflineRow } from '../src/components/MessageView';
import { APP_ROUTES } from '@kinu.run/core';

/** Markup with entity escapes resolved, so assertions quote the product's own words. */
function readable(markup: string): string {
  return markup
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

function renderRow(devices: Parameters<typeof DeviceOfflineRow>[0]['devices']): string {
  return readable(renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(DeviceOfflineRow, { devices })),
  ));
}

describe('device notice socket frames', () => {
  test('a refused call with one registered machine names it', () => {
    // One contiguous text node: asserting on markup proves the words sit inside the pill.
    expect(renderRow([{ id: 'dev-1', label: 'ashish@studio', lastSeenAt: 1_769_000_000_000 }]))
      .toContain('ashish@studio is offline');
  });

  test('several registered machines read as the fleet, not a list', () => {
    const html = renderRow([
      { id: 'dev-1', label: 'ashish@studio', lastSeenAt: 1_769_000_000_000 },
      { id: 'dev-2', label: 'ashish@tower', lastSeenAt: 1_768_999_000_000 },
    ]);

    expect(html).not.toBe('');
    expect(html).not.toContain('ashish@studio');
    expect(html).not.toContain('ashish@tower');
  });

  test('no registered machine names the way out, once', () => {
    const html = renderRow([]);

    expect(html).toContain(`href="${APP_ROUTES.devices}"`);
    // `>Connect<` is the anchor's own text; bare 'Connect' could match a class or attribute.
    expect(html).toContain('>Connect<');
  });

  test('a connect clears the notice: null renders nothing', () => {
    expect(renderRow(null)).toBe('');
  });
});
