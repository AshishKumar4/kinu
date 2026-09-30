/** Sign in with ChatGPT on the owner's machine (ADR P1); `legacy`, the Codex device code, without one. */
import { useEffect, useState, type ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import { Effect } from "effect";
import { attempt, renderThrownChain, settle } from "@kinu.run/core/obs";
import { CHATGPT_USAGE_URL, chatgptPlan, startChatGptSignIn, type ChatGptPlan } from "@/lib/user-api";
import { BrandMark } from "@/components/ui/BrandMark";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";

/** How often a waiting sign-in asks the machine whether the browser came back. */
const SIGN_IN_POLL_MS = 2_000;

/** SIWC UI guidelines' wording and link. */
export function ChatGptPlanUsage() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 p-meta p-text-3">
      <BrandMark brand="openai" size={11} bare />
      Using ChatGPT plan ·
      <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="p-accent underline underline-offset-2">Manage usage</a>
    </span>
  );
}

export function ChatGptConnect({ plan, legacy, onChanged }: { plan: ChatGptPlan; legacy: ReactNode; onChanged: () => void }) {
  const [waiting, setWaiting] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = (failure: { readonly cause?: unknown }) => Effect.sync(() => { setError(renderThrownChain({ cause: failure.cause ?? failure })); });

  // While the browser is away, ask the machine whether it came back.
  useEffect(() => {
    if (!waiting) return undefined;

    const timer = window.setInterval(() => settle(attempt({ doing: "reading the ChatGPT sign-in", otherwise: "io" }, chatgptPlan).pipe(
      Effect.map(({ status: now }) => {
        if (now?.signedIn === true) {
          setWaiting(false);

          if (now.firstSignIn) setWelcome(true);
          else onChanged();
        } else if (now !== null && !now.pending) {
          setWaiting(false);
          setError(now.lastFailure ?? "The sign-in did not finish.");
        }
      }),
      Effect.catch(shown),
    )), SIGN_IN_POLL_MS);

    return () => { window.clearInterval(timer); };
  }, [waiting, onChanged]);

  if (plan.device === null) return <>{legacy}</>;
  const { device, status } = plan;

  const signIn = () => {
    setError(null);
    // Opened inside the click, so no popup blocker stands between the owner and the sign-in.
    const tab = window.open("", "_blank");

    return attempt({ doing: "starting the ChatGPT sign-in", otherwise: "io" }, startChatGptSignIn).pipe(
      Effect.map(({ authorizeUrl }) => {
        if (tab === null) window.location.assign(authorizeUrl);
        else tab.location.href = authorizeUrl;
        setWaiting(true);
      }),
      Effect.catch((failure) => Effect.andThen(Effect.sync(() => tab?.close()), shown(failure))),
    );
  };

  const dismiss = () => {
    setWelcome(false);
    onChanged();
  };

  return (
    <div className="space-y-2">
      <p className="rounded-md px-3 py-2 text-xs p-notice-warning">
        Using your ChatGPT plan from kinu.run goes through your own device. OpenAI&apos;s open-source terms cover locally hosted apps, so you connect at your own risk.
      </p>
      {status?.planDeclined === true && (
        <p className="text-xs p-text-2">{status.email ?? "Your ChatGPT account"} signed in without ChatGPT plan usage. Continue with ChatGPT to allow it.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <FilledButton onClick={() => settle(signIn())} disabled={waiting}>Continue with ChatGPT</FilledButton>
        {waiting && <span className="p-meta p-text-3 flex items-center gap-2"><Loader size="sm" /> Waiting for the browser to come back to {device.label}…</span>}
      </div>
      <p className="p-meta p-text-3">
        Signs in on {device.label}, which keeps the sign-in and carries your ChatGPT plan&apos;s requests. Open it in a browser on that machine.
      </p>

      {error && <p className="text-xs p-danger">{error}</p>}
      {welcome && (
        <Modal title="You're using your ChatGPT plan" icon={<BrandMark brand="openai" size={16} bare />} onClose={dismiss}
          footer={<FilledButton onClick={dismiss}>Got it</FilledButton>}>
          <p className="text-sm p-text-2">
            Eligible requests in Kinu now use your ChatGPT plan. You can review and limit that usage in{" "}
            <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="p-accent underline underline-offset-2">ChatGPT settings</a>.
          </p>
        </Modal>
      )}
    </div>
  );
}
