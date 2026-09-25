/** A leaf module so tests can read the nav without mounting the sidebar. */
import {
  HouseIcon, SquaresFourIcon, HardDrivesIcon, PuzzlePieceIcon, DesktopTowerIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";

/** Account settings is absent on purpose: the sidebar footer gear is the one way in. `also` lights the row on more routes. */
export const PRIMARY_NAV: readonly {
  readonly to: string;
  readonly label: string;
  readonly Icon: typeof HouseIcon;
  readonly end: boolean;
  readonly also?: string;
}[] = [
  { to: APP_ROUTES.home, label: "Home", Icon: HouseIcon, end: true },
  { to: APP_ROUTES.workspaces, label: "Workspaces", Icon: SquaresFourIcon, end: false },
  { to: APP_ROUTES.drive, label: "Drive", Icon: HardDrivesIcon, end: false, also: APP_ROUTES.shared },
  { to: APP_ROUTES.devices, label: "Devices", Icon: DesktopTowerIcon, end: false },
  { to: APP_ROUTES.plugins, label: "Plugins", Icon: PuzzlePieceIcon, end: false },
];

export function navActive(item: { readonly to: string; readonly end: boolean; readonly also?: string }, pathname: string): boolean {
  const under = (root: string): boolean => pathname === root || pathname.startsWith(root === "/" ? "/" : `${root}/`);

  if (item.end ? pathname === item.to : under(item.to)) return true;

  return item.also !== undefined && under(item.also);
}

export function navRowCls(open: boolean): string {
  return open ? "bg-[var(--c-accent-subtle)]" : "hover:bg-[var(--c-elevated)]";
}
