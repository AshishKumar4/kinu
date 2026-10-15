/**
 * The owner's share sheet for one slate, from wherever they open it (its tab, its Drive tile): the slate's room, its
 * socket open while the sheet is.
 */
import { useState } from "react";
import { Loader } from "@cloudflare/kumo";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
import { useRoom } from "@/hooks/use-room";
import { ShareSheet } from "./ShareSheet";

export function RoomSheet({ workspace, slate, title, onClose }: { workspace: string; slate: string; title: string; onClose: () => void }) {
  const { view, call } = useRoom({ workspace, slate, linkKey: null });

  if (view?.sheet === null || view?.sheet === undefined) {
    return (
      <Modal title={`Share ${title}`} icon={<ShareNetworkIcon size={18} className="p-accent" />} onClose={onClose}>
        <div className="flex justify-center py-6"><Loader size="sm" /></div>
      </Modal>
    );
  }

  return <ShareSheet workspace={workspace} title={title} owner={view.session.owner} sheet={view.sheet} call={call} onClose={onClose} />;
}

/** The slate tab's share button and its sheet. */
export function RoomShareControl({ workspace, slate, title }: { workspace: string; slate: string; title: string }) {
  const [sharing, setSharing] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setSharing(true)} data-slate-share title={`Share ${title}`} aria-label={`Share ${title}`} className="p-bar-action">
        <ShareNetworkIcon size={12} />
      </button>
      {sharing && <RoomSheet workspace={workspace} slate={slate} title={title} onClose={() => setSharing(false)} />}
    </>
  );
}
