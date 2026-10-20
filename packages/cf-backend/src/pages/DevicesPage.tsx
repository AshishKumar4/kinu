import { DesktopTowerIcon } from "@phosphor-icons/react";
import { DevicesCard } from "@/components/devices/DevicesCard";
import { FormPage } from "@/components/ui/PageHeader";

export default function DevicesPage() {
  return <FormPage icon={<DesktopTowerIcon size={22} />} title="Devices"><DevicesCard /></FormPage>;
}
