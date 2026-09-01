/**
 * Account settings, as a place a person navigates.
 *
 * The page was one column of eight cards, and the report was that it is hard to
 * navigate: the thing you came for is somewhere in a scroll, and the deep link
 * every work surface carries — `/user/settings#devices` — landed mid-page with
 * nothing saying where you were.
 *
 * So the hash names a SECTION. It is the same hash those links already carry,
 * it survives a reload and the Back button, and an unknown one opens the first
 * section rather than a blank page — the case that matters, because a stale
 * bookmark is a hash nobody removed.
 */
import { Link } from "react-router-dom";
import {
  BrainIcon, DesktopTowerIcon, PlugIcon, TerminalIcon, UserCircleIcon,
} from "@phosphor-icons/react";

/** The five things an account owner comes here to do, keyed by their hash.
 *  Not exported: the rail below is the one renderer, and a second reader of
 *  this map would be a second place a new section has to be added. */
const SETTINGS_SECTIONS = {
  account: { label: "Account", Icon: UserCircleIcon },
  devices: { label: "Devices", Icon: DesktopTowerIcon },
  providers: { label: "Providers", Icon: PlugIcon },
  models: { label: "Models", Icon: BrainIcon },
  cli: { label: "CLI", Icon: TerminalIcon },
} as const;

export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

function isSettingsSection(id: string): id is SettingsSection {
  return Object.hasOwn(SETTINGS_SECTIONS, id);
}

/** Which section a URL hash opens. An unknown or absent hash opens the first
 *  one rather than an empty page. */
export function settingsSection(hash: string): SettingsSection {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  return isSettingsSection(id) ? id : "account";
}

/** A row that wraps on a narrow window, a column beside the content on a wide
 *  one — one tree, because two would drift. */
export function SettingsRail({ active }: { active: SettingsSection }) {
  return (
    <nav aria-label="Settings sections"
      className="flex flex-wrap gap-1 lg:w-40 lg:shrink-0 lg:flex-col lg:flex-nowrap lg:sticky lg:top-8 lg:self-start">
      {Object.entries(SETTINGS_SECTIONS).map(([id, { label, Icon }]) => (
        <Link
          key={id}
          to={{ hash: `#${id}` }}
          data-settings-section={id}
          aria-current={id === active ? "true" : undefined}
          className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
            id === active ? "p-accent-bg p-accent font-medium" : "p-text-3 hover:p-text"
          }`}
        >
          <Icon size={13} /> {label}
        </Link>
      ))}
    </nav>
  );
}
