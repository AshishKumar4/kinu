/**
 * The primary nav rows, in the order the rail draws them — a leaf module so a
 * test (or any consumer) can read the contract without mounting the sidebar
 * component closure.
 */
import {
  HouseIcon, SquaresFourIcon, HardDrivesIcon, PuzzlePieceIcon, DesktopTowerIcon, GearIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";

export const PRIMARY_NAV = [
  { to: APP_ROUTES.home, label: "Home", Icon: HouseIcon, end: true },
  { to: APP_ROUTES.workspaces, label: "Workspaces", Icon: SquaresFourIcon, end: false },
  { to: APP_ROUTES.shared, label: "Drive", Icon: HardDrivesIcon, end: false },
  { to: APP_ROUTES.devices, label: "Devices", Icon: DesktopTowerIcon, end: false },
  { to: APP_ROUTES.plugins, label: "Plugins", Icon: PuzzlePieceIcon, end: false },
  { to: APP_ROUTES.userSettings, label: "Settings", Icon: GearIcon, end: true },
] as const;
