/**
 * Account settings, as a place a person navigates.
 *
 * The report: "the settings page itself isn't very easy to navigate — maybe it
 * can have some tabbed views or links." It was one column of eight cards, and
 * `/user/settings#devices` — the link the Environment tab, the drive and every
 * per-agent settings page carry — landed mid-scroll with nothing saying where
 * you were.
 *
 * Two properties, and both are about the hash, because the hash is what a deep
 * link carries: the hash decides the section, and the rail says which section
 * that is. An unknown hash opens the first section rather than a blank page —
 * the failure mode that matters, because a stale bookmark is a hash nobody
 * removed.
 *
 * What is NOT here and is proved in the browser by
 * `scripts/chat-and-files-ux.test.ts`: that a section renders ALONE, and that
 * switching sections does not re-read the account.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SettingsRail, settingsSection, type SettingsSection } from '../src/components/SettingsRail';

/** The rail as a reader sees it, under a router, since every entry is a link
 *  that keeps the pathname and changes only the hash. */
function rail(active: SettingsSection): string {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [`/user/settings#${active}`] },
    createElement(SettingsRail, { active }),
  ));
}

/** Every section the rail publishes, read off the rail. A list retyped here
 *  would be a second copy of the set, and a section added to one and not the
 *  other is exactly the drift these assertions exist to catch. */
const RAW_IDS = [...rail('account').matchAll(/data-settings-section="([a-z]+)"/g)]
  .map((match) => match[1] ?? '');
/** The same ids as sections. Narrowed through the module's own reader, which
 *  the first assertion below pins to the identity on this set. */
const SECTION_IDS = RAW_IDS.map(settingsSection);

/** The one entry for `id`, as markup. */
function entry(html: string, id: string): string {
  const match = new RegExp(`<a[^>]*data-settings-section="${id}"[^>]*>`).exec(html);
  expect(match).not.toBeNull();
  return match![0];
}

describe('the URL hash decides the section', () => {
  test('every section is reachable by its own hash', () => {
    // Non-vacuity: a rail that published nothing would make this loop empty
    // and every id assertion below unfired.
    expect(RAW_IDS).toContain('devices');
    expect(RAW_IDS.length).toBeGreaterThan(3);
    // Not circular: an entry the reader does not recognise answers `account`,
    // which is not the id that was read off the rail.
    const read: string[] = RAW_IDS.map((raw) => settingsSection(`#${raw}`));
    expect(read).toEqual(RAW_IDS);
  });

  test('#devices — the link every surface already carries — opens Devices', () => {
    expect(settingsSection('#devices')).toBe('devices');
  });

  test('no hash opens the first section, never a blank page', () => {
    expect(settingsSection('')).toBe('account');
  });

  test('a hash nobody recognises opens the first section', () => {
    expect(settingsSection('#connections')).toBe('account');
    expect(settingsSection('#__proto__')).toBe('account');
  });

  test('a hash is read with or without its leading #', () => {
    expect(settingsSection('providers')).toBe('providers');
    expect(settingsSection('#providers')).toBe('providers');
  });
});

describe('the rail says which section is open', () => {
  test('the active entry is the only one marked current', () => {
    for (const active of SECTION_IDS) {
      const html = rail(active);
      const current = [...html.matchAll(/data-settings-section="([a-z]+)"[^>]*aria-current="true"/g)]
        .map((m) => m[1]);
      expect(current).toEqual([active]);
    }
  });

  test('the active entry carries the accent, the others carry the quiet tone', () => {
    const html = rail('devices');
    expect(entry(html, 'devices')).toContain('p-accent-bg p-accent');
    expect(entry(html, 'providers')).not.toContain('p-accent-bg');
    expect(entry(html, 'providers')).toContain('p-text-3');
  });

  test('every section is one click away, each link changing only the hash', () => {
    const html = rail('account');
    for (const id of SECTION_IDS) {
      expect(entry(html, id)).toContain(`href="/user/settings#${id}"`);
    }
    // The entries are readable words, not ids: the rail is what a person picks
    // a section from.
    expect(html).toContain('Devices');
    expect(html).toContain('Providers');
  });
});
