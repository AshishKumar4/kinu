/** Where every connect ends (`connectedPath`): it tells the tab that started it and closes, or says what happened. */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { connectEndedOf } from "@kinu.run/core";
import { finishConnect, type FinishedConnect } from "@/lib/connect-window";

/** What the page says once it is done: nothing while it goes back, its failure where this tab began the connect, and
 *  otherwise no outcome at all. Its address is anyone's to write, so it claims nothing it says: the page that began the
 *  connect is told, and shows the end itself. */
function said(finished: FinishedConnect, service: string, error: string | null) {
  if (finished.kind === "returning") return null;

  if (finished.kind === "unknown") return <p className="max-w-md text-center">This page has no connect to report. You can close this tab.</p>;

  if (finished.kind === "failed-here") {
    return <p className="max-w-md text-center">{service} did not connect: {error} <a className="underline" href={finished.back}>Go back</a></p>;
  }

  return <p className="max-w-md text-center">You can close this tab.</p>;
}

export default function ConnectedPage() {
  const [search] = useSearchParams();
  const ended = connectEndedOf(search);
  const [finished, setFinished] = useState<FinishedConnect>({ kind: "returning" });

  // The address names a run, a service and an error; the run is the starting page's own, and nothing here follows the rest.
  useEffect(() => { setFinished(finishConnect(ended)); }, [ended.run, ended.service, ended.error]);

  return (
    <div className="flex h-screen items-center justify-center p-6 p-bg p-text-2 text-sm" data-connect-finished={finished.kind}>
      {said(finished, ended.service, ended.error)}
    </div>
  );
}
