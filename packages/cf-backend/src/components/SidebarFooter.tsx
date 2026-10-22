import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { DesktopTowerIcon, EnvelopeSimpleIcon, GearIcon, GithubLogoIcon, ShieldCheckIcon, SignOutIcon } from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";
import { settingsPath, settingsSection } from "@/components/SettingsRail";
import { useAccount } from "@/hooks/use-account";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { lastValue } from "@/hooks/use-async-resource";
import { useImportantMail } from "@/hooks/use-important-mail";
import { Avatar } from "./ui/Avatar";
import { ModeToggle } from "./theme-toggle";
import { FeedbackButton } from "./FeedbackButton";
import { Pressable, PressableAnchor, PressableLink } from "@/components/ui/Pressable";
import { NavRow } from "@/components/ui/NavRow";
import { Surface } from "@/components/ui/Surface";
import { Count } from "@/components/ui/Badge";

/** Kinu's source. */
const KINU_REPOSITORY = "https://github.com/AshishKumar4/kinu";

/** A row of the account menu, as its theme and feedback rows are. */
const MENU_ROW = "t-body flex items-center gap-2 px-2 py-1";

/** Where the mail the assistant reads lands; Important is its first view. */
const MAIL_ROUTE = "/mail";

/** A count on an icon: hidden at nothing, and "9+" past nine. */
function CountBadge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;

  return (
    <Count count={count} label={label} data-count-badge={count} />
  );
}

/** Mail, with what the assistant marked Important and you have not read, and the machines you connected. */
export function FooterIcons({ vertical = false }: { vertical?: boolean }) {
  const { pathname, hash } = useLocation();
  const { enabled, unread } = useImportantMail();
  const at = (root: string) => pathname === root || pathname.startsWith(`${root}/`);
  // Devices is a Settings section: its icon is the open page while that section is.
  const devicesOpen = at(APP_ROUTES.userSettings) && settingsSection(hash) === "devices";
  const mailWords = unread > 0 ? `Mail, ${String(unread)} important unread` : "Mail";

  return (
    <div className={`flex items-center gap-px ${vertical ? "flex-col" : ""}`}>
      {enabled && <NavRow size="icon-sm" quiet current={at(MAIL_ROUTE)} to={MAIL_ROUTE} aria-label={mailWords} title={mailWords} data-footer-mail>
        <EnvelopeSimpleIcon size={17} />
        <CountBadge count={unread} label={`${String(unread)} important unread`} />
      </NavRow>}
      <NavRow size="icon-sm" quiet current={devicesOpen} to={settingsPath("devices")} aria-label="Devices" title="Devices" data-footer-devices>
        <DesktopTowerIcon size={17} />
      </NavRow>
    </div>
  );
}

/** The menu the account opens: who you are, Settings, the theme, feedback and Sign out. Above its button, so it opens upward. */
export function AccountMenu({ onClose, className }: { onClose: () => void; className: string }) {
  const account = useAccount();
  const profile = lastValue(account.profile);
  const failed = account.profile.status === "error";

  return (
    <Surface look="panel" className={`z-30 p-1 p-shadow-menu ${className}`} data-account-panel role="menu">
      <div className="mb-1 flex items-center gap-3 border-b p-border px-2 pb-2 pt-1">
        <Avatar name={profile?.displayName ?? profile?.email ?? "?"} size={28} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="t-item truncate p-text">{profile?.displayName ?? profile?.email ?? (failed ? "Could not load your profile" : "Loading…")}</span>
          {profile?.displayName !== undefined && profile.displayName !== null && <span className="t-meta truncate p-text-3">{profile.email}</span>}
        </span>
      </div>
      <PressableLink to={APP_ROUTES.userSettings} onClick={onClose} className={MENU_ROW}><GearIcon size={14} /><span>Settings</span></PressableLink>
      {profile?.controlPlane === true && (
        <PressableLink to={APP_ROUTES.control} onClick={onClose} className={MENU_ROW}><ShieldCheckIcon size={14} /><span>Control plane</span></PressableLink>
      )}
      <ModeToggle />
      <FeedbackButton />
      {/* Help: the source, here rather than in the phone's app bar (design review 2026-10-20). */}
      <PressableAnchor href={KINU_REPOSITORY} target="_blank" rel="noopener noreferrer" className={MENU_ROW}><GithubLogoIcon size={14} /><span>GitHub</span></PressableAnchor>
      <PressableAnchor href="/logout" className={MENU_ROW}><SignOutIcon size={14} /><span>Sign out</span></PressableAnchor>
    </Surface>
  );
}

/** The sidebar's foot: you, opening your menu, then Mail and Devices. */
export function SidebarFooter({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const profile = lastValue(useAccount().profile);
  const [open, setOpen] = useState(initiallyOpen);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useCloseOnOutsideClick(open, ref, close);

  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>("[data-account-menu]")?.focus();
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const name = profile?.displayName ?? profile?.email ?? "";

  return (
    <div ref={ref} className="relative flex items-center gap-1 border-t p-border px-2 py-2" data-sidebar-footer>
      <Pressable onClick={() => setOpen((shown) => !shown)} aria-expanded={open} aria-haspopup="menu" aria-label="Account menu" data-account-menu
        selected={open} className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-1 pr-2">
        <Avatar name={name === "" ? "?" : name} size={24} />
        <span className="t-item min-w-0 flex-1 truncate p-text">{name === "" ? "Account" : name}</span>
      </Pressable>
      <FooterIcons />
      {open && <AccountMenu onClose={close} className="absolute bottom-full left-2 right-2 mb-1" />}
    </div>
  );
}
