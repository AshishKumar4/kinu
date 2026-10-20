/** The URL hash names the section; an unknown hash opens the first one. */
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { APP_ROUTES } from "@kinu.run/core";
import {
  BrainIcon, ChartBarIcon, DesktopIcon, DesktopTowerIcon, FlaskIcon, KeyIcon, MagnifyingGlassIcon, NotebookIcon, PaintBrushIcon, PlugIcon, TerminalIcon, UserCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { tabCls } from "@/components/ui/form";
import { navRowClsLg } from "@/components/nav";

/** A section: its rail label, which names it on the page too (no head repeats it), and its icon. */
interface SettingsSectionSpec {
  readonly label: string;
  readonly Icon: Icon;
}

const SETTINGS_SECTIONS = {
  account: { label: "Account", Icon: UserCircleIcon },
  appearance: { label: "Appearance", Icon: PaintBrushIcon },
  devices: { label: "Devices", Icon: DesktopTowerIcon },
  providers: { label: "Providers", Icon: PlugIcon },
  secrets: { label: "Secrets", Icon: KeyIcon },
  models: { label: "Models", Icon: BrainIcon },
  search: { label: "Web search", Icon: MagnifyingGlassIcon },
  memory: { label: "Memory", Icon: NotebookIcon },
  computer: { label: "Computer", Icon: DesktopIcon },
  beta: { label: "Beta", Icon: FlaskIcon },
  usage: { label: "Usage", Icon: ChartBarIcon },
  cli: { label: "CLI", Icon: TerminalIcon },
} satisfies Record<string, SettingsSectionSpec>;

type SettingsSection = keyof typeof SETTINGS_SECTIONS;

/** A section's own address: Settings with the section in its hash. Devices lives here alone (design review 2026-10-20). */
export function settingsPath(section: SettingsSection): string {
  return `${APP_ROUTES.userSettings}#${section}`;
}

function isSettingsSection(id: string): id is SettingsSection {
  return Object.hasOwn(SETTINGS_SECTIONS, id);
}

export function settingsSection(hash: string): SettingsSection {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;

  return isSettingsSection(id) ? id : "account";
}

export function SettingsRail({ active }: { active: SettingsSection }) {
  const nav = useRef<HTMLElement>(null);

  // A deep link to the last entry would otherwise open with the active tab off-screen.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active]);

  return (
    <nav ref={nav} aria-label="Settings sections"
      className="p-tabstrip -mx-5 flex border-b p-border px-5 sm:-mx-8 sm:px-8 max-lg:[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)] lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:border-0 lg:px-0">
      {Object.entries(SETTINGS_SECTIONS).map(([id, { label, Icon }]) => {
        const current = id === active;

        return (
          <Link
            key={id}
            to={{ hash: `#${id}` }}
            data-settings-section={id}
            aria-current={current ? "true" : undefined}
            className={`${tabCls} ${current ? "p-tab-active" : ""} lg:mb-0 lg:border-b-0 lg:px-3 lg:py-[7px] ${navRowClsLg(current)}`}
          >
            <Icon size={15} className={current ? "" : "p-text-3"} /> {label}
          </Link>
        );
      })}
    </nav>
  );
}
