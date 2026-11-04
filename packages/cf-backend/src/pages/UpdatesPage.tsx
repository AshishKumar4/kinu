/**
 * `/updates` (docs/SELF-DEPLOY.md § Updates). The deployment pulls; there is no push.
 * A poll failing mid-run is expected: the Worker being replaced is the update working.
 */
import { settle } from "@kinu.run/core/obs";
import { Button } from "@/components/ui/Button";
import { Effect } from "effect";
import { Loader } from "@/components/ui/Loader";
import { ArrowUpIcon } from "@phosphor-icons/react";
import { DeploySnapshotSchema, UpdateOfferSchema, type DeploySnapshot, type UpdateBuild } from "@kinu.run/core/deploy";
import type * as v from "valibot";
import { StepRow } from "@/components/deploy/DeployStepRow";
import { Notice } from "@/components/ui/Notice";
import { Group } from "@/components/ui/Group";
import { Surface } from "@/components/ui/Surface";
import { ApiError, request, type HttpRequest } from "@/lib/http";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useLabelledStep } from "@/hooks/use-labelled-step";

const RUN_POLL_MS = 2000;

/** `/api/updates` answers 404 to everyone but the deployment's owner, so a 404 here means the reader is someone else. */
const NOT_OWNER = "Updates are installed by the person who deployed this Kinu. They see what is available here and install it.";

function read<Schema extends v.GenericSchema>(schema: Schema, path: string, init?: HttpRequest): Promise<v.InferOutput<Schema>> {
  return settle(Effect.catchDefect(request(schema, path, init), (died) => Effect.die(died instanceof ApiError && died.status === 404 ? new Error(NOT_OWNER) : died)));
}

const readOffer = () => read(UpdateOfferSchema, "/api/updates");

/** `apply` answers before the first step runs, so a page opened mid-update reads the ledger. */
const readRun = () => read(DeploySnapshotSchema, "/api/updates/run");

/** A run still going is read again until it ends. */
const pollWhileGoing = (held: DeploySnapshot | null): number | null => (held !== null && held.state !== "done" && held.state !== "failed" ? RUN_POLL_MS : null);

function Build({ label, build }: { label: string; build: UpdateBuild | null }) {
  return (
    <div>
      <p className="t-label">{label}</p>
      <p className="t-body mt-px p-text">{build === null ? "unknown" : build.version}</p>
      {build !== null && <p className="t-meta p-text-3">built {build.builtAt}</p>}
    </div>
  );
}

export default function UpdatesPage() {
  const offerRead = useAsyncResource(readOffer);
  // A mid-run read failure is the Worker being replaced: the run on screen stays, its cause beside the restart notice.
  const runRead = useAsyncResource(readRun, pollWhileGoing);
  const held = lastValue(runRead.resource);
  const run = held !== null && held.steps.length > 0 ? held : null;
  const offer = lastValue(offerRead.resource);
  const restarting = runRead.resource.status === "error" && run !== null ? runRead.resource.message : null;
  const { busy, error, run: start } = useLabelledStep();

  const err = (offerRead.resource.status === "error" ? offerRead.resource.message : null)
    ?? (runRead.resource.status === "error" && held === null ? runRead.resource.message : null)
    ?? error;

  const going = pollWhileGoing(run) !== null;

  const apply = (): void => start("apply", async () => runRead.set(await read(DeploySnapshotSchema, "/api/updates/apply", { method: "POST" })));

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <div>
        <h1 className="t-page-title">Updates</h1>
        <p className="t-body mt-1 p-text-2">
          This Kinu installs its own updates. It reads the release channel and runs the same steps
          that first put it here, with its own Cloudflare key.
        </p>
      </div>
      {err !== null && (err.includes(NOT_OWNER)
        ? <p className="t-body p-text-2" data-updates="not-owner">{NOT_OWNER}</p>
        : <Notice tone="danger">{err}</Notice>)}
      {offer === null && err === null && <div className="flex justify-center py-16"><Loader size="base" /></div>}
      {offer !== null && (
        <section className="space-y-4" aria-label="This deployment's build">
          <Surface look="panel" className="space-y-4 px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <Build label="Running" build={offer.current} />
              <Build label="Published" build={offer.available} />
              <div>
                <p className="t-label">Channel</p>
                <p className="t-meta mt-px p-text-3">
                  {offer.channelOrigin === "" ? "none" : offer.channelOrigin}
                </p>
              </div>
            </div>
            {offer.reason !== "" && <p className="t-body p-text-2">{offer.reason}</p>}
            {offer.upToDate && <p className="t-body p-text" data-updates="up-to-date">Up to date.</p>}
            {offer.installable && (
              <Button variant="primary" size="md" onClick={apply} busy={busy !== null} disabled={going}>
                <ArrowUpIcon size={15} /> Install {offer.available?.version ?? ""}
              </Button>
            )}
          </Surface>
        </section>
      )}
      {run !== null && run.steps.length > 0 && (
        <section className="space-y-2" aria-label="Update steps">
          <h2 className="t-label">{run.state === "done" ? "What it did" : "Installing"}</h2>
          {restarting !== null && (
            <p className="t-meta p-text-3" data-updates="restarting">
              This deployment is restarting on the new version, so the last steps may show up late.
              The last check failed with: {restarting}
            </p>
          )}
          <Group list>
            {run.steps.map((row) => <StepRow key={row.id} row={row} />)}
          </Group>
          {run.state === "done" && (
            <p className="t-body p-text" data-updates="installed">
              Kinu {run.version} is now running.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
