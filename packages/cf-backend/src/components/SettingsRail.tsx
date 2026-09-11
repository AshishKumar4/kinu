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
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
  BrainIcon, DesktopTowerIcon, PlugIcon, TerminalIcon, UserCircleIcon,
} from "@phosphor-icons/react";
import { tabCls } from "@/components/ui/form";

/** The five things an account owner comes here to do, keyed by their hash,
 *  each with the one line the section head says about what it changes.
 *  Not exported: the rail and the head below are the two renderers, and a
 *  third reader of this map would be a third place a new section has to be
 *  added. */
const SETTINGS_SECTIONS = {
  account: { label: "Account", Icon: UserCircleIcon, about: "Who you are signed in as." },
  devices: { label: "Devices", Icon: DesktopTowerIcon, about: "Machines linked to this account. A workspace you approve can run commands on them." },
  providers: { label: "Providers", Icon: PlugIcon, about: "Model access for every workspace you own." },
  models: { label: "Models", Icon: BrainIcon, about: "Which model each tier and role uses, in every workspace you own." },
  cli: { label: "CLI", Icon: TerminalIcon, about: "The command line, on a machine of yours." },
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

/** The head of the open section: its name and what it changes. A deep link
 *  lands here, so the reader knows where they are before the first card. */
export function SettingsSectionHead({ section }: { section: SettingsSection }) {
  const { label, about } = SETTINGS_SECTIONS[section];

  return (
    <header className="mb-5">
      <h2 className="p-heading text-[19px] leading-6 p-text">{label}</h2>
      <p className="mt-1 p-row-text p-text-3">{about}</p>
    </header>
  );
}

/** A tab strip on a narrow window, a column beside the content on a wide one
 *  — one tree, because two would drift. Below `lg` the entries ride the same
 *  strip the work surfaces use, so a long set scrolls instead of wrapping into
 *  a second row of pills. */
export function SettingsRail({ active }: { active: SettingsSection }) {
  const nav = useRef<HTMLElement>(null);

  // On a phone the strip scrolls, and a deep link to its last entry would
  // otherwise open with the current tab off the right edge and no tab lit.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active]);

  return (
    <nav ref={nav} aria-label="Settings sections"
      className="p-tabstrip -mx-5 flex border-b p-border px-5 sm:-mx-6 sm:px-6 lg:mx-0 lg:w-48 lg:shrink-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:border-0 lg:px-0 lg:sticky lg:top-8 lg:self-start">
      {Object.entries(SETTINGS_SECTIONS).map(([id, { label, Icon }]) => {
        const current = id === active;

        return (
          <Link
            key={id}
            to={{ hash: `#${id}` }}
            data-settings-section={id}
            aria-current={current ? "true" : undefined}
            className={`${tabCls} ${current ? "p-tab-active" : ""} lg:mb-0 lg:rounded-md lg:border-b-0 lg:px-3 lg:py-2 lg:text-[13px] ${
              current
                ? "lg:bg-[var(--c-accent-subtle)] lg:text-[var(--c-accent-fg)]"
                : "lg:text-[var(--c-text-2)] lg:hover:bg-[var(--c-neutral-tint)] lg:hover:text-[var(--c-text)]"
            }`}
          >
            <Icon size={15} className={current ? "" : "p-text-3"} /> {label}
          </Link>
        );
      })}
    </nav>
  );
}
