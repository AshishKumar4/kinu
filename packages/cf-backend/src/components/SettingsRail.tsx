/** The URL hash names the section; an unknown hash opens the first one. */
import { APP_ROUTES } from "@kinu.run/core";
import {
  BrainIcon, ChartBarIcon, DesktopIcon, DesktopTowerIcon, FlaskIcon, KeyIcon, MagnifyingGlassIcon, NotebookIcon, PaintBrushIcon, PlugIcon, TerminalIcon, UserCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { Rail } from "@/components/ui/Rail";

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
  const items = Object.entries(SETTINGS_SECTIONS).map(([id, { label, Icon }]) => ({
    id, label, icon: <Icon size={16} />, to: { hash: `#${id}` }, data: { "data-settings-section": id },
  }));

  // Edge to edge on a phone and a tablet, as the page's own gutter runs.
  return <Rail label="Settings sections" items={items} current={active} className="-mx-5 px-5 sm:-mx-8 sm:px-8 lg:mx-0 lg:px-0" />;
}
