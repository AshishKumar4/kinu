/**
 * Account settings sections: the URL hash decides the section and the rail marks it; an unknown hash
 * (a stale bookmark) opens the first section. Rendering alone is proved in `scripts/chat-and-files-ux.test.ts`.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SettingsRail, settingsSection, type SettingsSection } from '../src/components/SettingsRail';
import { present } from '@kinu.run/test-utils';

/** Under a router: every entry is a link that changes only the hash. */
function rail(active: SettingsSection): string {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [`/user/settings#${active}`] },
    createElement(SettingsRail, { active }),
  ));
}

/** Read off the rail, not retyped, so a section added to one copy but not the other is caught. */
const RAW_IDS = [...rail('account').matchAll(/data-settings-section="([a-z]+)"/g)]
  .map((match) => match[1] ?? '');

const SECTION_IDS = RAW_IDS.map(settingsSection);

function entry(html: string, id: string): string {
  const match = present(new RegExp(`<a[^>]*data-settings-section="${id}"[^>]*>`).exec(html), `the ${id} settings link`);

  return match[0];
}

describe('the URL hash decides the section', () => {
  test('every section is reachable by its own hash', () => {
    // Non-vacuity: an empty rail would leave every id assertion unfired.
    expect(RAW_IDS).toContain('devices');
    expect(RAW_IDS.length).toBeGreaterThan(3);
    // Not circular: an unrecognised entry reads as `account`.
    const read: string[] = RAW_IDS.map((raw) => settingsSection(`#${raw}`));
    expect(read).toEqual(RAW_IDS);
  });

  test('#devices — the link every surface already carries — opens Devices', () => {
    expect(settingsSection('#devices')).toBe('devices');
  });

  test('no hash opens the first section, never a blank page', () => {
    expect(settingsSection('')).toBe('account');
  });

  const HASH_CASES = [
    { name: 'a hash nobody recognises opens the first section', hashes: ['#connections', '#__proto__'], opens: 'account' },
    { name: 'a hash is read with or without its leading #', hashes: ['providers', '#providers'], opens: 'providers' },
  ] as const;

  for (const { name, hashes, opens } of HASH_CASES) {
    test(name, () => {
      for (const hash of hashes) expect(settingsSection(hash)).toBe(opens);
    });
  }
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

  test('every section is one click away, each link changing only the hash', () => {
    const html = rail('account');

    for (const id of SECTION_IDS) {
      expect(entry(html, id)).toContain(`href="/user/settings#${id}"`);
    }

    expect(html).toContain('Devices');
    expect(html).toContain('Providers');
  });
});
