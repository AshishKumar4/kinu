/** A leaf module so tests can read the nav without mounting the sidebar. */
import {
  HouseIcon, SquaresFourIcon, HardDrivesIcon, PuzzlePieceIcon, CompassIcon,
} from "@phosphor-icons/react";
import { matchPath } from "react-router-dom";
import { APP_ROUTES } from "@kinu.run/core";

/** Settings, Mail and Devices are the sidebar footer's: the account menu, and the icons beside it. `also` lights the row on more
 *  routes, and on the pages below them. */
export const PRIMARY_NAV: readonly {
  readonly to: string;
  readonly label: string;
  readonly Icon: typeof HouseIcon;
  readonly end: boolean;
  readonly also?: readonly string[];
}[] = [
  { to: APP_ROUTES.home, label: "Home", Icon: HouseIcon, end: true },
  { to: APP_ROUTES.workspaces, label: "Workspaces", Icon: SquaresFourIcon, end: false },
  { to: APP_ROUTES.drive, label: "Drive", Icon: HardDrivesIcon, end: false, also: [APP_ROUTES.slates, APP_ROUTES.shared] },
  { to: APP_ROUTES.explore, label: "Explore", Icon: CompassIcon, end: false, also: [APP_ROUTES.gallerySlate] },
  { to: APP_ROUTES.plugins, label: "Plugins", Icon: PuzzlePieceIcon, end: false },
];

export function navActive(item: { readonly to: string; readonly end: boolean; readonly also?: readonly string[] }, pathname: string): boolean {
  const under = (root: string): boolean => pathname === root || pathname.startsWith(root === "/" ? "/" : `${root}/`);

  if (item.end ? pathname === item.to : under(item.to)) return true;

  return item.also?.some((route) => matchPath({ path: route, end: false }, pathname) !== null) ?? false;
}


