import { DesktopTowerIcon } from "@phosphor-icons/react";
import { DevicesCard } from "@/components/devices/DevicesCard";
import { PAGE_BODY, PageHeader } from "@/components/ui/PageHeader";

export default function DevicesPage() {
  return (
    <div className="h-full overflow-y-auto">
      {/* A page of forms: it starts on every page's left edge and stops at a reading width. */}
      <div className={`max-w-4xl space-y-6 ${PAGE_BODY}`}>
        <PageHeader icon={<DesktopTowerIcon size={22} />} title="Devices" />
        <DevicesCard />
      </div>
    </div>
  );
}
