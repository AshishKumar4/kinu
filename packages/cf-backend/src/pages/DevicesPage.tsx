/**
 * Devices — every machine linked to this account, with the live link state
 * the roster publishes and the workspaces each consent grants or denies.
 * One row answers both halves of the question a bare "allowed" could not:
 * whether the machine is online, and which workspaces it may act for.
 */
import { DesktopTowerIcon } from "@phosphor-icons/react";
import { DevicesCard } from "@/components/devices/DevicesCard";

export default function DevicesPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <header className="flex items-center gap-3">
          <DesktopTowerIcon size={22} className="shrink-0 p-text-3" />
          <h1 className="p-display text-2xl">Devices</h1>
        </header>
        <DevicesCard allGrants />
      </div>
    </div>
  );
}
