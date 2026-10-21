/**
 * `/deploy` (docs/SELF-DEPLOY-FLOW.md): a Kinu of your own on your own Cloudflare account. Public: its sign-in is the
 * page's own, to Cloudflare, held in a cookie of this Kinu, and every read and the run it starts are that sign-in's.
 * Start, Ready (and its Domain step), Deploying, Live; a person whose account already runs a Kinu starts on its changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import { useSearchParams } from "react-router-dom";
import type { DeployedKinu, DeployRunRequest, DeployRunView, DeploySession } from "@kinu.run/core/deploy";
import { detach } from "@kinu.run/core/obs";
import { Loader } from "@/components/ui/Loader";
import { CloudflareSaid, DeployShell, type RefusalActions } from "@/components/deploy/DeployParts";
import { DeployStart, type DeclinedSignIn } from "@/components/deploy/DeployStart";
import { DeployManage, type KinuChange } from "@/components/deploy/DeployManage";
import { DeployReady, type ReadyFor } from "@/components/deploy/DeployReady";
import { DeployLive, DeployRunning, type RunAsked } from "@/components/deploy/DeployRun";
import {
  beginRun, beginSignIn, continueRun, readRun, readSession, type DeployHeard, type DeployRefused,
} from "@/lib/deploy-page-api";

/** How often a followed run is read again, by where it stands: it goes on in Cloudflare whether or not this page reads. */
const FOLLOW_MS = { running: 2000, paused: 5000, pending: 15_000 } as const;

type Stage =
  | { readonly kind: "loading" }
  | { readonly kind: "start" }
  | { readonly kind: "failed"; readonly refusal: DeployRefused }
  | { readonly kind: "manage"; readonly session: DeploySession }
  | { readonly kind: "ready"; readonly session: DeploySession; readonly readyFor: ReadyFor }
  | { readonly kind: "run"; readonly run: DeployRunView; readonly asked: RunAsked };

function declinedOf(params: URLSearchParams): DeclinedSignIn | null {
  const error = params.get("error") ?? "";

  return error === "" ? null : { error, description: params.get("error_description") ?? "" };
}

/** A run that waits on a sign-in to carry on: one paused past its grant, or one whose domain is ready to move onto. */
function waitsOnSignIn(run: DeployRunView): boolean {
  return run.paused?.id === "signin-again" || run.live?.pending?.ready === true;
}

/** How long until the followed run is read again, or null once it has nothing left to do by itself. */
function followIn(run: DeployRunView): number | null {
  if (waitsOnSignIn(run)) return null;

  if (run.state === "running") return FOLLOW_MS.running;

  if (run.state === "paused") return FOLLOW_MS.paused;

  return run.state === "live" && run.live?.pending !== undefined ? FOLLOW_MS.pending : null;
}

/**
 * Reads the followed run again while it goes, and stops once it is done, refused, or waiting on a sign-in. A read the
 * door refuses is heard too; `attempt` reads again after one, since the run's own answer did not change.
 */
function useFollow(run: DeployRunView | null, attempt: number, onHeard: (heard: DeployHeard<DeployRunView | null>) => void): void {
  useEffect(() => {
    const wait = run === null ? null : followIn(run);

    if (wait === null) return undefined;

    let current = true;

    const timer = setTimeout(() => detach(Effect.promise(async () => {
      const heard = await readRun();

      if (current) onHeard(heard);
    })), wait);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [run, attempt, onHeard]);
}

function Failed({ refusal }: { refusal: DeployRefused }) {
  return (
    <DeployShell dot={1} screen="failed" title="Kinu couldn't read your Cloudflare account">
      <p role="alert" className="t-body">{refusal.refused?.sentence ?? refusal.need?.sentence ?? refusal.error}</p>
      {refusal.refused !== null && <div className="mt-3"><CloudflareSaid words={refusal.refused.details} /></div>}
    </DeployShell>
  );
}

export default function DeployPage() {
  const [params] = useSearchParams();
  const declined = useRef(declinedOf(params)).current;
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [signingIn, setSigningIn] = useState(false);
  const [deploying, setDeploying] = useState(false);
  // The last refusal the door answered on this screen: cleared when the screen changes or a read succeeds.
  const [refusal, setRefusal] = useState<DeployRefused | null>(null);
  const [handedOff, setHandedOff] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const go = useCallback((next: Stage) => {
    setRefusal(null);
    setStage(next);
  }, []);

  // A run waiting on a sign-in carries on once there is one; a carry-on the door refuses keeps the run and says why.
  const follow = useCallback((run: DeployRunView, asked: RunAsked, signedIn: boolean, here: () => boolean) => Effect.gen(function* () {
    if (!signedIn || !waitsOnSignIn(run)) {
      go({ kind: "run", run, asked });

      return;
    }

    const carried = yield* Effect.promise(async () => continueRun());

    if (!here()) return;

    if ("refusal" in carried) {
      setStage({ kind: "run", run, asked });
      setRefusal(carried.refusal);

      return;
    }

    go({ kind: "run", run: carried.answer ?? run, asked });
  }), [go]);

  // Where a signed-in person lands: the run they left, else the Kinus they have, else a new one.
  const land = useCallback((session: DeploySession, here: () => boolean) => Effect.gen(function* () {
    if (session.resume !== null) {
      const heard = yield* Effect.promise(async () => readRun());

      if (!here()) return;

      if ("answer" in heard && heard.answer !== null) {
        yield* follow(heard.answer, null, session.signedIn, here);

        return;
      }
    }

    go(session.deployments.length > 0 ? { kind: "manage", session } : { kind: "ready", session, readyFor: { kind: "new" } });
  }), [follow, go]);

  // `here` is false once the page has left (or mounted again): an arrival in flight then does nothing more, so a run is
  // carried on at most once however often the page arrives.
  const arrive = useCallback((here: () => boolean) => Effect.gen(function* () {
    if (declined !== null) {
      go({ kind: "start" });

      return;
    }

    const heard = yield* Effect.promise(async () => readSession());

    if (!here()) return;

    if ("refusal" in heard) {
      go(heard.refusal.need?.id === "signin-again" ? { kind: "start" } : { kind: "failed", refusal: heard.refusal });

      return;
    }

    if (!heard.answer.signedIn) {
      go({ kind: "start" });

      return;
    }

    yield* land(heard.answer, here);
  }), [declined, go, land]);

  useEffect(() => {
    let here = true;

    detach(arrive(() => here));

    return () => { here = false; };
  }, [arrive]);

  // Signs in to Cloudflare in this tab; coming back, the page lands again and carries on a run that waited on it.
  const signIn = useCallback(() => Effect.gen(function* () {
    setSigningIn(true);
    setRefusal(null);
    const heard = yield* Effect.promise(async () => beginSignIn());

    if ("refusal" in heard) {
      setRefusal(heard.refusal);
      setSigningIn(false);

      return;
    }

    location.assign(heard.answer.location);
  }), []);

  const onSignIn = useCallback(() => detach(signIn()), [signIn]);

  const asked = stage.kind === "run" ? stage.asked : null;

  const onHeard = useCallback((heard: DeployHeard<DeployRunView | null>) => {
    if ("refusal" in heard) {
      setRefusal(heard.refusal);

      // A sign-in run out waits on the person; anything else is read again.
      if (heard.refusal.need?.id !== "signin-again") setAttempt((count) => count + 1);

      return;
    }

    if (heard.answer !== null) go({ kind: "run", run: heard.answer, asked });
  }, [asked, go]);

  useFollow(stage.kind === "run" ? stage.run : null, attempt, onHeard);

  const deploy = (request: DeployRunRequest, kind: RunAsked) => Effect.gen(function* () {
    setDeploying(true);
    setRefusal(null);
    const begun = yield* Effect.promise(async () => beginRun(request));

    if ("refusal" in begun) {
      setRefusal(begun.refusal);
      setDeploying(false);

      return;
    }

    const heard = yield* Effect.promise(async () => readRun());

    setDeploying(false);
    setHandedOff(null);

    if ("refusal" in heard) setRefusal(heard.refusal);
    else if (heard.answer !== null) go({ kind: "run", run: heard.answer, asked: kind });
  });

  const retry = () => Effect.gen(function* () {
    setRetrying(true);
    const heard = yield* Effect.promise(async () => continueRun());

    setRetrying(false);

    if ("refusal" in heard) setRefusal(heard.refusal);
    else if (heard.answer !== null) go({ kind: "run", run: heard.answer, asked });
  });

  const change = (session: DeploySession, kinu: DeployedKinu, picked: KinuChange) => {
    if (picked === "update") return deploy({ kind: "update", account: kinu.account, name: kinu.name }, "update");

    if (picked === "link") return deploy({ kind: "change", account: kinu.account, name: kinu.name, setupLink: true }, "change");

    return Effect.sync(() => go({ kind: "ready", session, readyFor: { kind: picked, kinu } }));
  };

  const backTo = (session: DeploySession) => go(session.deployments.length > 0 ? { kind: "manage", session } : { kind: "start" });

  // Back to the Kinus this sign-in has, read again: a run just done is one of them now.
  const manage = () => Effect.gen(function* () {
    setStage({ kind: "loading" });
    const heard = yield* Effect.promise(async () => readSession());

    go("answer" in heard && heard.answer.signedIn ? { kind: "manage", session: heard.answer } : { kind: "start" });
  });

  const refusalActions: RefusalActions = { signingIn, onSignIn, onHandedOff: setHandedOff };

  if (stage.kind === "loading") {
    return (
      <DeployShell dot={0} screen="loading">
        <p className="inline-flex items-center gap-2 t-body" aria-busy="true"><Loader size="sm" />Opening…</p>
      </DeployShell>
    );
  }

  if (stage.kind === "start") return <DeployStart declined={declined} refusal={refusal?.error ?? null} signingIn={signingIn} onSignIn={onSignIn} />;

  if (stage.kind === "failed") return <Failed refusal={stage.refusal} />;

  if (stage.kind === "manage") {
    const { session } = stage;

    return (
      <DeployManage session={session} starting={deploying} refusal={refusal} refusalActions={refusalActions}
        onChange={(kinu, picked) => detach(change(session, kinu, picked))} onDeployAnother={() => go({ kind: "ready", session, readyFor: { kind: "new" } })} />
    );
  }

  if (stage.kind === "ready") {
    const { session, readyFor } = stage;

    return (
      <DeployReady session={session} readyFor={readyFor} deploying={deploying} refusal={refusal} refusalActions={refusalActions}
        onDeploy={(request) => detach(deploy(request, request.kind))} onBack={() => backTo(session)} />
    );
  }

  const { run } = stage;

  if (run.state === "live" && run.live !== undefined) {
    return <DeployLive run={{ ...run, live: run.live }} asked={stage.asked} refusal={refusal} actions={refusalActions} onAddDomain={() => detach(manage())} />;
  }

  return <DeployRunning run={run} asked={stage.asked} handedOff={handedOff} retrying={retrying} refusal={refusal} actions={refusalActions} onRetry={() => detach(retry())} />;
}
