/** A leaf module so tests can read the nav without mounting the sidebar. */
import {
  HouseIcon, SquaresFourIcon, HardDrivesIcon, PuzzlePieceIcon, DesktopTowerIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";

/** Account settings is absent on purpose: the sidebar footer gear is the one way in. */
export const PRIMARY_NAV = [
  { to: APP_ROUTES.home, label: "Home", Icon: HouseIcon, end: true },
  { to: APP_ROUTES.workspaces, label: "Workspaces", Icon: SquaresFourIcon, end: false },
  { to: APP_ROUTES.drive, label: "Drive", Icon: HardDrivesIcon, end: false },
  { to: APP_ROUTES.devices, label: "Devices", Icon: DesktopTowerIcon, end: false },
  { to: APP_ROUTES.plugins, label: "Plugins", Icon: PuzzlePieceIcon, end: false },
] as const;
