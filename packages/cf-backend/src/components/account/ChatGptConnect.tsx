/** Connect a ChatGPT plan two ways: through a machine running Kinu, which keeps the sign-in, or here, by pasting back
 *  the local address the sign-in lands on. */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import { Effect } from "effect";
import { ArrowSquareOutIcon, DesktopTowerIcon, GlobeIcon } from "@phosphor-icons/react";
import { attempt, renderThrownChain, detach } from "@kinu.run/core/obs";
import {
  CHATGPT_USAGE_URL, cancelChatGptSignIn, chatgptPlan, finishChatGptPaste, registerDevice, startChatGptPaste, startChatGptSignIn,
  type ChatGptPlan,
} from "@/lib/user-api";
import { BrandMark } from "@/components/ui/BrandMark";
import { CopyButton } from "@/components/ui/CopyButton";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";
import { inputCls } from "@/components/ui/form";

/** How often a waiting sign-in is read. */
const SIGN_IN_POLL_MS = 2_000;

/** SIWC UI guidelines' wording; the usage link is the sign-in welcome's, not every model's. */
export function ChatGptPlanUsage() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 p-meta p-text-3">
      <BrandMark brand="openai" size={11} bare />
      Using ChatGPT plan
    </span>
  );
}

type Way = "pc" | "here";

const PASTE_OUTCOME = {
  declined: "You cancelled the sign-in at OpenAI.",
  plan_declined: "You signed in without allowing ChatGPT plan usage; allow it this time.",
} as const;

export function ChatGptWelcome({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="You're using your ChatGPT plan" icon={<BrandMark brand="openai" size={16} bare />} onClose={onClose}
      footer={<FilledButton onClick={onClose}>Got it</FilledButton>}>
      <p className="text-sm p-text-2">
        Eligible requests in Kinu now use your ChatGPT plan. You can review and limit that usage in{" "}
        <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="p-accent underline underline-offset-2">ChatGPT settings</a>.
      </p>
    </Modal>
  );
}

export function ChatGptConnect({ plan, onSignedIn }: { plan: ChatGptPlan; onSignedIn: (first: boolean) => void }) {
  const [way, setWay] = useState<Way | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = useCallback((failure: { readonly cause?: unknown }) => Effect.sync(() => { setError(renderThrownChain({ cause: failure.cause ?? failure })); }), []);

  const finished = useCallback((first: boolean) => {
    setWay(null);
    onSignedIn(first);
  }, [onSignedIn]);

  const cancel = useCallback(() => detach(attempt({ doing: "cancelling the ChatGPT sign-in", otherwise: "io" }, cancelChatGptSignIn).pipe(
    Effect.map(() => { setWay(null); setError(null); }),
    Effect.catch(shown),
  )), [shown]);

  const gaveUp = useCallback((reason: string) => {
    setWay(null);
    setError(reason);
  }, []);

  return (
    <div className="space-y-3" data-chatgpt-connect>
      <p className="rounded-md px-3 py-2 text-xs p-notice-warning">
        OpenAI&apos;s open-source terms cover locally hosted apps, so you connect your ChatGPT plan to kinu.run at your own risk.
      </p>
      {plan.status?.planDeclined === true && (
        <p className="text-xs p-text-2">{plan.status.email ?? "Your ChatGPT account"} signed in without ChatGPT plan usage. Sign in again to allow it.</p>
      )}
      {way === null && (
        <div className="grid gap-2 sm:grid-cols-2">
          <WayButton icon={<DesktopTowerIcon size={16} />} title="Use your PC"
            text="Sign in on a machine running Kinu. The sign-in stays on that machine." onClick={() => { setError(null); setWay("pc"); }} />
          <WayButton icon={<GlobeIcon size={16} />} title="Sign in here"
            text="Sign in in this browser, then paste back the address it lands on." onClick={() => { setError(null); setWay("here"); }} />
        </div>
      )}
      {way === "pc" && <OnYourPc plan={plan} onDone={finished} onGaveUp={gaveUp} onFailed={shown} />}
      {way === "here" && <SignInHere onDone={finished} onFailed={shown} />}
      {way !== null && (
        <button type="button" onClick={cancel} className="p-meta p-text-3 underline-offset-2 hover:p-text hover:underline">Cancel</button>
      )}
      {error && <p role="alert" className="text-xs p-danger">{error}</p>}
    </div>
  );
}

function WayButton({ icon, title, text, onClick }: { icon: ReactNode; title: string; text: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex flex-col items-start gap-1 rounded-xl border p-border px-3.5 py-3 text-left transition-colors hover:border-[var(--c-border-strong)] hover:bg-[var(--c-neutral-tint)]">
      <span className="flex items-center gap-2 text-[13px] font-medium p-text">{icon}{title}</span>
      <span className="p-meta p-text-3">{text}</span>
    </button>
  );
}

type Failed = (failure: { readonly cause?: unknown }) => Effect.Effect<void>;

/** Signs in through a machine, first handing the command that connects one. */
function OnYourPc({ plan, onDone, onGaveUp, onFailed }: {
  plan: ChatGptPlan; onDone: (first: boolean) => void; onGaveUp: (reason: string) => void; onFailed: Failed;
}) {
  const [current, setCurrent] = useState(plan);
  const [command, setCommand] = useState<string | null>(null);

  useEffect(() => {
    detach(attempt({ doing: "starting the ChatGPT sign-in", otherwise: "io" }, startChatGptSignIn).pipe(
      Effect.map((machineSignIn) => { setCurrent((was) => ({ ...was, machineSignIn })); }),
      Effect.catch(onFailed),
    ));
  }, [onFailed]);

  useEffect(() => {
    const timer = window.setInterval(() => detach(attempt({ doing: "reading the ChatGPT sign-in", otherwise: "io" }, chatgptPlan).pipe(
      Effect.map((now) => {
        const ended = now.status;

        if (ended?.signedIn === true) onDone(ended.firstSignIn);
        // A sign-in the machine opened and then gave up on ends here, in its own words.
        else if (now.machineSignIn?.state !== "waiting_for_machine" && ended !== null && !ended.pending && ended.lastFailure !== null) onGaveUp(ended.lastFailure);
        else setCurrent(now);
      }),
      Effect.catch(onFailed),
    )), SIGN_IN_POLL_MS);

    return () => { window.clearInterval(timer); };
  }, [onDone, onGaveUp, onFailed]);

  const signIn = current.machineSignIn;
  const needsMachine = signIn?.state === "waiting_for_machine";

  useEffect(() => {
    if (!needsMachine || command !== null) return;
    detach(attempt({ doing: "making the connect command", otherwise: "io" }, () => registerDevice()).pipe(
      Effect.map(({ installCommand }) => { setCommand(installCommand); }),
      Effect.catch(onFailed),
    ));
  }, [needsMachine, command, onFailed]);

  if (signIn?.state === "open") {
    return (
      <div className="space-y-2" data-chatgpt-way="pc" data-chatgpt-state="open">
        <p className="text-xs p-text-2">Sign in from a browser on <span className="font-medium p-text">{signIn.device.label}</span>. The sign-in comes back to that machine.</p>
        <div className="flex flex-wrap items-center gap-2">
          <a href={signIn.authorizeUrl} target="_blank" rel="noopener noreferrer" className="p-btn-quiet inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
            <ArrowSquareOutIcon size={12} /> Open ChatGPT sign-in
          </a>
          <CopyButton value={signIn.authorizeUrl} what="the sign-in link" size={13} className="p-btn-quiet inline-flex size-7 items-center justify-center" />
        </div>
        <p className="flex items-center gap-2 p-meta p-text-3"><Loader size="sm" /> Waiting for the sign-in to finish on {signIn.device.label}…</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-chatgpt-way="pc" data-chatgpt-state="waiting">
      <p className="text-xs p-text-2">Run this on your PC. It installs the Kinu CLI and connects the machine; the sign-in then opens there.</p>
      {command !== null && (
        <div className="flex items-start gap-2 rounded-md p-fill border p-border p-3">
          <code data-connect-command className="p-t-code p-text flex-1 break-all select-all">{command}</code>
          <CopyButton value={command} what="the connect command" size={13} className="p-text-3 hover:p-text shrink-0" />
        </div>
      )}
      <p className="flex items-center gap-2 p-meta p-text-3"><Loader size="sm" /> Waiting for your machine…</p>
    </div>
  );
}

/** Signs in here; the local address the browser lands on is pasted back. */
function SignInHere({ onDone, onFailed }: { onDone: (first: boolean) => void; onFailed: Failed }) {
  const [started, setStarted] = useState<{ authorizeUrl: string; redirectUri: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const begin = useCallback(() => {
    setStarted(null);
    setPasted("");
    setNote(null);
    detach(attempt({ doing: "starting the ChatGPT sign-in", otherwise: "io" }, startChatGptPaste).pipe(
      Effect.map(setStarted),
      Effect.catch(onFailed),
    ));
  }, [onFailed]);

  useEffect(begin, [begin]);

  const finish = useCallback(() => {
    setBusy(true);
    setNote(null);
    detach(attempt({ doing: "finishing the ChatGPT sign-in", otherwise: "io" }, () => finishChatGptPaste(pasted.trim())).pipe(
      Effect.map((answer) => {
        if (answer.outcome === "signed_in") onDone(true);
        else setNote(PASTE_OUTCOME[answer.outcome]);
      }),
      Effect.catch(onFailed),
      Effect.ensuring(Effect.sync(() => setBusy(false))),
    ));
  }, [pasted, onDone, onFailed]);

  if (started === null) return <p className="flex items-center gap-2 p-meta p-text-3" data-chatgpt-way="here"><Loader size="sm" /> Preparing the sign-in…</p>;

  return (
    <div className="space-y-3" data-chatgpt-way="here">
      <div className="space-y-1.5">
        <p className="text-xs p-text-2">1. Open ChatGPT and sign in.</p>
        <a href={started.authorizeUrl} target="_blank" rel="noopener noreferrer" className="p-btn-quiet inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
          <ArrowSquareOutIcon size={12} /> Open ChatGPT sign-in
        </a>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs p-text-2">2. Your browser then lands on a page that does not load, at an address starting with <code className="font-mono">{started.redirectUri}</code>. Copy that whole address and paste it here.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder={`${started.redirectUri}?code=…`}
            aria-label="Address the sign-in landed on" className={`${inputCls} text-xs`} disabled={busy} />
          <FilledButton onClick={finish} disabled={busy || pasted.trim() === ""} className="shrink-0">{busy ? "Finishing…" : "Finish"}</FilledButton>
        </div>
      </div>
      {note && (
        <p className="flex flex-wrap items-center gap-2 text-xs p-warning">
          {note}
          <button type="button" onClick={begin} className="p-btn-quiet px-2 py-1 text-xs">Start again</button>
        </p>
      )}
    </div>
  );
}
