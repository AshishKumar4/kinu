/**
 * `/updates` (docs/SELF-DEPLOY.md § Updates). The deployment pulls; there is no push.
 * A poll failing mid-run is expected: the Worker being replaced is the update working.
 */
import { showing, detach } from "@kinu.run/core/obs";
import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import { Loader } from "@cloudflare/kumo";
import { ArrowUpIcon } from "@phosphor-icons/react";
import {
  DeploySnapshotSchema, UpdateOfferSchema,
  type DeploySnapshot, type UpdateBuild, type UpdateOffer,
} from "@kinu.run/core/deploy";
import * as v from "valibot";
import { FilledButton } from "@/components/ui/FilledButton";
import { StepRow } from "@/components/deploy/DeployStepRow";

const RUN_POLL_MS = 2000;

/** `/api/updates` answers 404 to everyone but the deployment's owner, so a 404 here means the reader is someone else. */
const NOT_OWNER = "Updates are installed by the person who deployed this Kinu. They see what is available here and install it.";

function read<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  init: RequestInit = {},
): Effect.Effect<v.InferOutput<Schema>> {
  return Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetch(path, init));

    if (response.status === 404) return yield* Effect.die(new Error(NOT_OWNER));

    if (!response.ok) {
      const said = v.safeParse(v.object({ error: v.string() }), yield* Effect.promise(() => response.json()));

      return yield* Effect.die(new Error(said.success ? said.output.error : `${path} answered HTTP ${String(response.status)}`));
    }

    return v.parse(schema, yield* Effect.promise(() => response.json()));
  });
}

function Build({ label, build }: { label: string; build: UpdateBuild | null }) {
  return (
    <div>
      <p className="p-eyebrow">{label}</p>
      <p className="mt-0.5 p-row-text p-text">{build === null ? "unknown" : build.version}</p>
      {build !== null && <p className="p-meta p-text-3">built {build.builtAt}</p>}
    </div>
  );
}

export default function UpdatesPage({ fixture, fixtureRun }: {
  fixture?: UpdateOffer;
  fixtureRun?: DeploySnapshot;
} = {}) {
  const live = fixture === undefined && fixtureRun === undefined;
  const [offer, setOffer] = useState<UpdateOffer | null>(fixture ?? null);
  const [run, setRun] = useState<DeploySnapshot | null>(fixtureRun ?? null);
  const [err, setErr] = useState<string | null>(null);
  /** Last poll failure, or null; held so a failure other than the restart still shows on the page. */
  const [restarting, setRestarting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!live) return;
    let mounted = true;

    const failed = showing((chain) => { if (mounted) setErr(chain); });

    detach(Effect.all([
      Effect.catchCause(Effect.map(read(UpdateOfferSchema, "/api/updates"), (held) => { if (mounted) setOffer(held); }), failed),
      // `apply` answers before the first step runs, so a page opened mid-update reads the ledger.
      Effect.catchCause(Effect.map(read(DeploySnapshotSchema, "/api/updates/run"), (held) => {
        if (mounted && held.steps.length > 0) setRun(held);
      }), failed),
    ], { concurrency: 'unbounded' }));

    return () => { mounted = false; };
  }, [live]);

  const going = run !== null && run.state !== "done" && run.state !== "failed";

  useEffect(() => {
    if (!live || !going) return;
    let mounted = true;

    // A mid-run read failure is the Worker being replaced; its cause shows beside the restart notice.
    const timer = setInterval(() => detach(Effect.catchCause(Effect.map(read(DeploySnapshotSchema, "/api/updates/run"), (held) => {
      if (!mounted) return;
      setRestarting(null);
      setRun(held);
    }), showing((chain) => { if (mounted) setRestarting(chain); }))), RUN_POLL_MS);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [live, going]);

  const apply = useCallback(() => {
    setBusy(true);
    setErr(null);

    detach(Effect.ensuring(Effect.catchCause(Effect.map(read(DeploySnapshotSchema, "/api/updates/apply", { method: "POST" }), setRun), showing(setErr)), Effect.sync(() => setBusy(false))));
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <div>
        <h1 className="p-display text-2xl">Updates</h1>
        <p className="mt-1 text-sm p-text-2">
          This Kinu installs its own updates. It reads the release channel and runs the same steps
          that first put it here, with its own Cloudflare key.
        </p>
      </div>
      {err !== null && (err.includes(NOT_OWNER)
        ? <p className="text-sm p-text-2" data-updates="not-owner">{NOT_OWNER}</p>
        : <div className="p-notice-danger rounded-md px-3 py-2 text-xs" role="alert">{err}</div>)}
      {offer === null && err === null && <div className="flex justify-center py-16"><Loader size="base" /></div>}
      {offer !== null && (
        <section className="space-y-4" aria-label="This deployment's build">
          <div className="p-card space-y-4 px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <Build label="Running" build={offer.current} />
              <Build label="Published" build={offer.available} />
              <div>
                <p className="p-eyebrow">Channel</p>
                <p className="mt-0.5 p-meta p-text-3">
                  {offer.channelOrigin === "" ? "none" : offer.channelOrigin}
                </p>
              </div>
            </div>
            {offer.reason !== "" && <p className="text-sm p-text-2">{offer.reason}</p>}
            {offer.upToDate && <p className="p-row-text p-text" data-updates="up-to-date">Up to date.</p>}
            {offer.installable && (
              <FilledButton onClick={apply} disabled={busy || going} className="!h-9 !px-4 !text-sm">
                <ArrowUpIcon size={15} /> Install {offer.available?.version ?? ""}
              </FilledButton>
            )}
          </div>
        </section>
      )}
      {run !== null && run.steps.length > 0 && (
        <section className="space-y-2" aria-label="Update steps">
          <h2 className="p-eyebrow">{run.state === "done" ? "What it did" : "Installing"}</h2>
          {restarting !== null && (
            <p className="p-meta p-text-3" data-updates="restarting">
              This deployment is restarting on the new version, so the last steps may show up late.
              The last check failed with: {restarting}
            </p>
          )}
          <ul className="space-y-2">
            {run.steps.map((row) => <StepRow key={row.id} row={row} />)}
          </ul>
          {run.state === "done" && (
            <p className="p-row-text p-text" data-updates="installed">
              Kinu {run.version} is now running.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
