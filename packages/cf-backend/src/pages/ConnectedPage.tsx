/** Where every connect ends (`connectedPath`): it tells the tab that started it and closes, or says it is done. */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { connectEndedOf } from "@kinu.run/core";
import { finishConnect } from "@/lib/connect-window";

export default function ConnectedPage() {
  const [search] = useSearchParams();
  const ended = connectEndedOf(search);
  const [returning, setReturning] = useState(true);

  // The address is anyone's to write: it names a service and an error, and nothing here follows from it.
  useEffect(() => { setReturning(finishConnect(ended)); }, [ended.service, ended.error]);

  return (
    <div className="flex h-screen items-center justify-center p-6 p-bg p-text-2 text-sm" data-connect-finished={ended.error === null ? "connected" : "failed"}>
      {returning ? null : (
        <p className="max-w-md text-center">
          {ended.error === null ? `Connected to ${ended.service}.` : `${ended.service} did not connect: ${ended.error}`} You can close this tab.
        </p>
      )}
    </div>
  );
}
