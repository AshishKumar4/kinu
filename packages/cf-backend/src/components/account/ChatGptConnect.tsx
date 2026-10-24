/** Connect a ChatGPT plan two ways: through a machine running Kinu, which keeps the sign-in, or here, by pasting back
 *  the local address the sign-in lands on. */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Loader } from "@/components/ui/Loader";
import { Effect } from "effect";
import { ArrowSquareOutIcon, DesktopTowerIcon, GlobeIcon } from "@phosphor-icons/react";
import { attempt, renderThrownChain, detach } from "@kinu.run/core/obs";
import { CHATGPT_USAGE_URL } from "@kinu.run/core";
import {
  cancelChatGptSignIn, chatgptPlan, finishChatGptPaste, registerDevice, startChatGptPaste, startChatGptSignIn,
  type ChatGptPlan,
} from "@/lib/user-api";
import { BrandMark } from "@/components/ui/BrandMark";
import { CopyButton } from "@/components/ui/CopyButton";
import { Modal } from "@/components/ui/Modal";
import { Pressable } from "@/components/ui/Pressable";
import { CopyField } from "@/components/ui/CopyField";
import { useProviderWindow } from "@/hooks/use-provider-window";
import { DeadPage, SignInOpen, SignInPaste, SignInRisk, SignInStep, SignInSteps, useReturned } from "@/components/account/SubscriptionSignIn";

/** How often a waiting sign-in is read. */
const SIGN_IN_POLL_MS = 2_000;

/** SIWC UI guidelines' wording; the usage link is the sign-in welcome's, not every model's. */
export function ChatGptPlanUsage() {
  return (
    <span className="t-meta inline-flex shrink-0 items-center gap-1 p-text-3">
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
      footer={<Button variant="primary" size="sm" onClick={onClose}>Got it</Button>}>
      <p className="t-body p-text-2">
        Eligible requests in Kinu now use your ChatGPT plan. You can review and limit that usage in{" "}
        <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="p-accent-fg underline underline-offset-2">ChatGPT settings</a>.
      </p>
    </Modal>
  );
}

/** A sign-in's failure, said under it, and the handler that says it. */
function useShownFailure() {
  const [error, setError] = useState<string | null>(null);
  const shown = useCallback((failure: { readonly cause?: unknown }) => Effect.sync(() => { setError(renderThrownChain({ cause: failure.cause ?? failure })); }), []);

  return { error, setError, shown };
}

/** A second ChatGPT login, named `account`, signed in here and pasted back: the account holds it, as the main one. */
export function ChatGptAccountSignIn({ account, onDone }: { account: string; onDone: () => void }) {
  const { error, shown } = useShownFailure();

  return (
    <div className="space-y-3" data-chatgpt-account={account}>
      <SignInHere account={account} onDone={onDone} onFailed={shown} />
      {error && <p role="alert" className="t-meta p-danger">{error}</p>}
    </div>
  );
}

export function ChatGptConnect({ plan, onSignedIn }: { plan: ChatGptPlan; onSignedIn: (first: boolean) => void }) {
  const [way, setWay] = useState<Way | null>(null);
  const { error, setError, shown } = useShownFailure();

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
      <SignInRisk>OpenAI&apos;s terms cover apps you host yourself, so connecting kinu.run is at your own risk.</SignInRisk>
      {plan.status?.planDeclined === true && (
        <p className="t-meta p-text-2">{plan.status.email ?? "Your ChatGPT account"} signed in without ChatGPT plan usage. Sign in again to allow it.</p>
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
        <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
      )}
      {error && <p role="alert" className="t-meta p-danger">{error}</p>}
    </div>
  );
}

function WayButton({ icon, title, text, onClick }: { icon: ReactNode; title: string; text: string; onClick: () => void }) {
  return (
    // A row to pick, not a box inside the card (design review 2026-10-20).
    <Pressable onClick={onClick} className="-mx-2 flex flex-col items-start gap-1 px-2 py-2">
      <span className="t-item flex items-center gap-2">{icon}{title}</span>
      <span className="t-meta">{text}</span>
    </Pressable>
  );
}

type Failed = (failure: { readonly cause?: unknown }) => Effect.Effect<void>;

/** Signs in through a machine, first handing the command that connects one. */
function OnYourPc({ plan, onDone, onGaveUp, onFailed }: {
  plan: ChatGptPlan; onDone: (first: boolean) => void; onGaveUp: (reason: string) => void; onFailed: Failed;
}) {
  const [current, setCurrent] = useState(plan);
  const [command, setCommand] = useState<string | null>(null);
  const signInWindow = useProviderWindow("chatgpt-sign-in");

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

        if (ended?.signedIn === true) {
          signInWindow.close();
          onDone(ended.firstSignIn);
        }
        // A sign-in the machine opened and then gave up on ends here, in its own words.
        else if (now.machineSignIn?.state !== "waiting_for_machine" && ended !== null && !ended.pending && ended.lastFailure !== null) onGaveUp(ended.lastFailure);
        else setCurrent(now);
      }),
      Effect.catch(onFailed),
    )), SIGN_IN_POLL_MS);

    return () => { window.clearInterval(timer); };
  }, [onDone, onGaveUp, onFailed, signInWindow]);

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
        <p className="t-meta p-text-2">Sign in from a browser on <span className="p-text">{signIn.device.label}</span>. The sign-in comes back to that machine.</p>
        <div className="flex flex-wrap items-center gap-2">
          <a href={signIn.authorizeUrl} target="_blank" rel="noopener noreferrer" onClick={signInWindow.open} className={buttonClass({ size: "sm" })}>
            <ArrowSquareOutIcon size={12} /> Open ChatGPT sign-in
          </a>
          <CopyButton variant="secondary" value={signIn.authorizeUrl} what="the sign-in link" />
        </div>
        <p className="t-meta flex items-center gap-2 p-text-3"><Loader size="sm" /> Waiting for the sign-in to finish on {signIn.device.label}…</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-chatgpt-way="pc" data-chatgpt-state="waiting">
      <p className="t-meta p-text-2">Run this on your PC. It installs the Kinu CLI and connects the machine; the sign-in then opens there.</p>
      {command !== null && (
        <div data-connect-command><CopyField value={command} what="the connect command" /></div>
      )}
      <p className="t-meta flex items-center gap-2 p-text-3"><Loader size="sm" /> Waiting for your machine…</p>
    </div>
  );
}

/**
 * Signs in here; the address the browser lands on is pasted back. The page it lands on does not load, and the owner
 * (2026-10-23) read what to do with it only once it was gone: so it is said, and drawn, before OpenAI opens, in a tab of
 * its own that stays on that page; back here, the paste step is what the card shows.
 */
/** `account` names a second login; without it, the main one. */
function SignInHere({ onDone, onFailed, account }: { onDone: (first: boolean) => void; onFailed: Failed; account?: string }) {
  const [started, setStarted] = useState<{ authorizeUrl: string; redirectUri: string } | null>(null);
  const [opened, setOpened] = useState(false);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const returned = useReturned(opened);

  const begin = useCallback(() => {
    setStarted(null);
    setOpened(false);
    setPasted("");
    setProblem(null);
    detach(attempt({ doing: "starting the ChatGPT sign-in", otherwise: "io" }, () => startChatGptPaste(account)).pipe(
      Effect.map(setStarted),
      Effect.catch(onFailed),
    ));
  }, [onFailed, account]);

  useEffect(begin, [begin]);

  const finish = useCallback(() => {
    setBusy(true);
    setProblem(null);
    detach(Effect.tryPromise({ try: () => finishChatGptPaste(pasted.trim()), catch: (cause) => cause }).pipe(
      Effect.map((answer) => {
        if (answer.outcome === "signed_in") onDone(true);
        else setProblem(PASTE_OUTCOME[answer.outcome]);
      }),
      // The address refused says what was wrong with it, under the field it was pasted into.
      Effect.catch((cause) => Effect.sync(() => { setProblem(renderThrownChain({ cause })); })),
      Effect.ensuring(Effect.sync(() => setBusy(false))),
    ));
  }, [pasted, onDone]);

  if (started === null) return <p className="t-meta flex items-center gap-2 p-text-3" data-chatgpt-way="here"><Loader size="sm" /> Preparing the sign-in…</p>;

  const landing = new URL(started.redirectUri);
  const host = `${landing.host}${landing.pathname}`;
  const page = <DeadPage host={host} rest="?code=ac_…&scope=…&state=…" />;

  return (
    <div className="space-y-3" data-chatgpt-way="here" data-chatgpt-step={opened ? "paste" : "before"}>
      <SignInSteps>
        <SignInStep n={1} state={opened ? "done" : "now"} title="Sign in at OpenAI, in a new tab">
          {!opened && (
            <>
              <p className="t-body p-text-2">
                After you approve, OpenAI sends that tab to a page that won&apos;t load. <b className="p-text">That&apos;s expected.</b> Leave it open, copy its
                whole address, and come back to this tab.
              </p>
              {page}
              {/* A tab of its own, never the popup (the owner, 2026-10-23): the page it ends on stays until it is copied. */}
              <SignInOpen href={started.authorizeUrl} label="Got it, open OpenAI" onOpen={() => setOpened(true)} />
            </>
          )}
        </SignInStep>
        <SignInStep n={2} state={opened ? "now" : "next"} title="Copy the address of the page that didn't load">
          {opened && !returned && page}
        </SignInStep>
        <SignInStep n={3} state={opened ? "now" : "next"} title="Paste it here">
          {opened && (
            <div className={returned ? "space-y-3" : undefined} data-paste-returned={returned ? "" : undefined}>
              {returned && page}
              <SignInPaste label="The address you copied" placeholder={`${started.redirectUri}?code=…`} value={pasted} onChange={setPasted}
                onSubmit={finish} busy={busy} problem={problem} action="Finish" />
            </div>
          )}
        </SignInStep>
      </SignInSteps>
      {problem !== null && opened && <Button size="sm" variant="ghost" onClick={begin}>Start again</Button>}
    </div>
  );
}
