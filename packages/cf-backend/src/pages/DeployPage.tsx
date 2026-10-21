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
import { CloudflareSaid, DeployShell } from "@/components/deploy/DeployParts";
import { DeployStart, type DeclinedSignIn } from "@/components/deploy/DeployStart";
import { DeployManage, type KinuChange } from "@/components/deploy/DeployManage";
import { DeployReady, type ReadyFor } from "@/components/deploy/DeployReady";
import { DeployLive, DeployRunning, type RunAsked } from "@/components/deploy/DeployRun";
import {
  beginRun, beginSignIn, continueRun, readRun, readSession, type DeployHeard, type DeployRefused,
} from "@/lib/deploy-page-api";

/**
 * A run this tab will carry on once its sign-in comes back: kept across the sign-in's round trip to Cloudflare, under
 * the run's id, so a sign-in for anything else carries nothing on.
 */
const CARRY_ON_KEY = "kinu.deploy.carry-on";

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

/** How long until the followed run is read again, or null once it has nothing left to do by itself. */
function followIn(run: DeployRunView): number | null {
  if (run.state === "running") return FOLLOW_MS.running;

  if (run.state === "paused") return FOLLOW_MS.paused;

  return run.state === "live" && run.live?.pending !== undefined && !run.live.pending.ready ? FOLLOW_MS.pending : null;
}

/** Reads the followed run again while it goes, and stops once it is done or refused. */
function useFollow(run: DeployRunView | null, onRead: (run: DeployRunView) => void): void {
  useEffect(() => {
    const wait = run === null ? null : followIn(run);

    if (wait === null) return undefined;

    let current = true;

    const timer = setTimeout(() => detach(Effect.promise(async () => {
      const heard = await readRun();

      if (current && "answer" in heard && heard.answer !== null) onRead(heard.answer);
    })), wait);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [run, onRead]);
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
  const [signInRefusal, setSignInRefusal] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [refusal, setRefusal] = useState<DeployRefused | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Where a signed-in person lands: the run they left, else the Kinus they have, else a new one.
  const land = useCallback((session: DeploySession) => Effect.gen(function* () {
    if (session.resume !== null) {
      const carryOn = sessionStorage.getItem(CARRY_ON_KEY) === session.resume.runId;

      sessionStorage.removeItem(CARRY_ON_KEY);
      const heard: DeployHeard<DeployRunView | null> = yield* Effect.promise(async () => (carryOn ? continueRun() : readRun()));

      if ("answer" in heard && heard.answer !== null) {
        setStage({ kind: "run", run: heard.answer, asked: null });

        return;
      }
    }

    setStage(session.deployments.length > 0 ? { kind: "manage", session } : { kind: "ready", session, readyFor: { kind: "new" } });
  }), []);

  const arrive = useCallback(() => Effect.gen(function* () {
    if (declined !== null) {
      setStage({ kind: "start" });

      return;
    }

    const heard = yield* Effect.promise(async () => readSession());

    if ("refusal" in heard) {
      setStage(heard.refusal.need?.id === "signin-again" ? { kind: "start" } : { kind: "failed", refusal: heard.refusal });

      return;
    }

    if (!heard.answer.signedIn) {
      setStage({ kind: "start" });

      return;
    }

    yield* land(heard.answer);
  }), [declined, land]);

  useEffect(() => { detach(arrive()); }, [arrive]);

  /** Signs in to Cloudflare in this tab; `carryOn` is the run to carry on once it comes back. */
  const signIn = (carryOn: string | null) => Effect.gen(function* () {
    setSigningIn(true);
    setSignInRefusal(null);
    const heard = yield* Effect.promise(async () => beginSignIn());

    if ("refusal" in heard) {
      setSignInRefusal(heard.refusal.error);
      setSigningIn(false);

      return;
    }

    if (carryOn === null) sessionStorage.removeItem(CARRY_ON_KEY);
    else sessionStorage.setItem(CARRY_ON_KEY, carryOn);
    location.assign(heard.answer.location);
  });

  const following = stage.kind === "run" ? stage.run : null;
  const asked = stage.kind === "run" ? stage.asked : null;
  const onRead = useCallback((run: DeployRunView) => setStage({ kind: "run", run, asked }), [asked]);

  useFollow(following, onRead);

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
    setHandedOff(false);

    if ("answer" in heard && heard.answer !== null) setStage({ kind: "run", run: heard.answer, asked: kind });
    else if ("refusal" in heard) setRefusal(heard.refusal);
  });

  const retry = () => Effect.gen(function* () {
    setRetrying(true);
    const heard = yield* Effect.promise(async () => continueRun());

    setRetrying(false);

    if ("answer" in heard && heard.answer !== null) setStage({ kind: "run", run: heard.answer, asked });
  });

  const change = (session: DeploySession, kinu: DeployedKinu, picked: KinuChange) => {
    setRefusal(null);

    if (picked === "update") return deploy({ kind: "update", account: kinu.account, name: kinu.name }, "update");

    if (picked === "link") return deploy({ kind: "change", account: kinu.account, name: kinu.name, setupLink: true }, "change");

    return Effect.sync(() => setStage({ kind: "ready", session, readyFor: { kind: picked, kinu } }));
  };

  const backTo = (session: DeploySession) => {
    setRefusal(null);
    setStage(session.deployments.length > 0 ? { kind: "manage", session } : { kind: "start" });
  };

  // Back to the Kinus this sign-in has, read again: a run just done is one of them now.
  const manage = () => Effect.gen(function* () {
    setStage({ kind: "loading" });
    const heard = yield* Effect.promise(async () => readSession());

    setStage("answer" in heard && heard.answer.signedIn ? { kind: "manage", session: heard.answer } : { kind: "start" });
  });

  if (stage.kind === "loading") {
    return (
      <DeployShell dot={0} screen="loading">
        <p className="inline-flex items-center gap-2 t-body" aria-busy="true"><Loader size="sm" />Opening…</p>
      </DeployShell>
    );
  }

  if (stage.kind === "start") return <DeployStart declined={declined} refusal={signInRefusal} signingIn={signingIn} onSignIn={() => detach(signIn(null))} />;

  if (stage.kind === "failed") return <Failed refusal={stage.refusal} />;

  if (stage.kind === "manage") {
    const { session } = stage;

    return <DeployManage session={session} onChange={(kinu, picked) => detach(change(session, kinu, picked))} onDeployAnother={() => setStage({ kind: "ready", session, readyFor: { kind: "new" } })} />;
  }

  if (stage.kind === "ready") {
    const { session, readyFor } = stage;

    return (
      <DeployReady session={session} readyFor={readyFor} deploying={deploying} refusal={refusal} signingIn={signingIn}
        onDeploy={(request) => detach(deploy(request, request.kind))} onSignIn={() => detach(signIn(null))} onBack={() => backTo(session)} />
    );
  }

  const { run } = stage;

  if (run.state === "live" && run.live !== undefined) {
    return <DeployLive run={{ ...run, live: run.live }} asked={stage.asked} signingIn={signingIn} onSignIn={() => detach(signIn(run.runId))} onAddDomain={() => detach(manage())} />;
  }

  return (
    <DeployRunning run={run} asked={stage.asked} handedOff={handedOff} signingIn={signingIn} retrying={retrying}
      onHandedOff={() => setHandedOff(true)} onSignIn={() => detach(signIn(run.runId))} onRetry={() => detach(retry())} />
  );
}
