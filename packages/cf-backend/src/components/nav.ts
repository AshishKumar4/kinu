/**
 * The primary nav rows, in the order the rail draws them — a leaf module so a
 * test (or any consumer) can read the contract without mounting the sidebar
 * component closure.
 */
import {
  HouseIcon, SquaresFourIcon, HardDrivesIcon, PuzzlePieceIcon, DesktopTowerIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";

/** Account settings is absent here on purpose: the gear beside the account
 *  email at the foot of the sidebar is the one way in, and a second row for
 *  the same page made two controls for one destination. */
export const PRIMARY_NAV = [
  { to: APP_ROUTES.home, label: "Home", Icon: HouseIcon, end: true },
  { to: APP_ROUTES.workspaces, label: "Workspaces", Icon: SquaresFourIcon, end: false },
  { to: APP_ROUTES.shared, label: "Drive", Icon: HardDrivesIcon, end: false },
  { to: APP_ROUTES.devices, label: "Devices", Icon: DesktopTowerIcon, end: false },
  { to: APP_ROUTES.plugins, label: "Plugins", Icon: PuzzlePieceIcon, end: false },
] as const;
