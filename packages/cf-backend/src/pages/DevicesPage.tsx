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
        <DevicesCard />
      </div>
    </div>
  );
}
