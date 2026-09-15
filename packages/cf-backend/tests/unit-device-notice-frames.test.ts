/**
 * The workspace socket frames behind the offline notice, and the row they
 * render. The frames are produced by the UserDO fan-out (covered in
 * unit-device-grants) and consumed by useKinu's socket listener; what this
 * file pins is the middle and the end: the wire shape the listener accepts,
 * and the exact words the thread shows for one machine, several, or none.
 *
 * The frames ride the production socket path, not an exported parser: the
 * row renders from props exactly as DeviceOfflineRow receives them.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { DeviceOfflineRow } from '../src/components/MessageView';

/** What a reader sees: the markup with its entity escapes resolved, so every
 *  assertion below can quote the product's own words. */
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
    const text = renderRow([{ id: 'dev-1', label: 'ashish@studio', lastSeenAt: 1_769_000_000_000 }])
      .replace(/<[^>]+>/g, '');

    expect(text).toContain('ashish@studio is offline');
  });

  test('several registered machines read as the fleet, not a list', () => {
    const text = renderRow([
      { id: 'dev-1', label: 'ashish@studio', lastSeenAt: 1_769_000_000_000 },
      { id: 'dev-2', label: 'ashish@tower', lastSeenAt: 1_768_999_000_000 },
    ]).replace(/<[^>]+>/g, '');

    expect(text).toContain('Your computers are offline');
    expect(text).not.toContain('ashish@studio');
  });

  test('no registered machine names the way out, once', () => {
    const html = renderRow([]);
    const text = html.replace(/<[^>]+>/g, '');

    expect(text).toContain('No computer connected');
    expect(html).toContain('/user/settings#devices');
    expect(text).toContain('Connect');
  });

  test('a connect clears the notice: null renders nothing', () => {
    expect(renderRow(null)).toBe('');
  });
});
