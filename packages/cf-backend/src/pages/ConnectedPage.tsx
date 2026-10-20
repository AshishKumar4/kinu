/** Where every connect ends (`connectedPath`): it tells the tab that started it and closes, or says what happened. */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { connectEndedOf } from "@kinu.run/core";
import { finishConnect, type FinishedConnect } from "@/lib/connect-window";

/** What the page says once it is done: nothing while it goes back, else the end in its own words. */
function said(finished: FinishedConnect, service: string, error: string | null) {
  if (finished.kind === "returning") return null;

  if (finished.kind === "unknown") return <p className="max-w-md text-center">This page has no connect to report. You can close this tab.</p>;

  if (finished.kind === "failed-here") {
    return <p className="max-w-md text-center">{service} did not connect: {error} <a className="underline" href={finished.back}>Go back</a></p>;
  }

  return (
    <p className="max-w-md text-center">
      {error === null ? `Connected to ${service}.` : `${service} did not connect: ${error}`} You can close this tab.
    </p>
  );
}

export default function ConnectedPage() {
  const [search] = useSearchParams();
  const ended = connectEndedOf(search);
  const [finished, setFinished] = useState<FinishedConnect>({ kind: "returning" });

  // The address names a run, a service and an error; the run is the starting page's own, and nothing here follows the rest.
  useEffect(() => { setFinished(finishConnect(ended)); }, [ended.run, ended.service, ended.error]);

  const outcome = ended.error === null ? "connected" : "failed";

  return (
    <div className="flex h-screen items-center justify-center p-6 p-bg p-text-2 text-sm" data-connect-finished={finished.kind === "unknown" ? "unknown" : outcome}>
      {said(finished, ended.service, ended.error)}
    </div>
  );
}
