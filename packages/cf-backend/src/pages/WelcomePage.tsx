/** First-run setup wizard; an unfinished account lands here from any URL. */
import { Cause, Effect } from 'effect';
import { useState, useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { Button, buttonClass } from "@/components/ui/Button";
import {
  AppWindowIcon, DesktopTowerIcon, SparkleIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import {
  APP_ROUTES, ONBOARDING_STEPS, PERSONAL_ASSISTANT_ID, suggestedMailUsername,
} from "@kinu.run/core";
import { renderThrownChain, settle, showing, detach } from "@kinu.run/core/obs";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { DisplayNameField } from "@/components/account/DisplayNameField";
import { ProvidersPanel } from "@/components/account/ProvidersPanel";
import { DefaultModelField } from "@/components/account/DefaultModelField";
import { WebSearchSettings } from "@/components/account/WebSearchSettings";
import { AssistantStep, DEFAULT_ASSISTANT, type AssistantChoice } from "@/components/assistant/AssistantStep";
import { personName } from "@/hooks/use-chat-mascot";
import { McpServersSection } from "@/components/account/McpServersPanel";
import { completeOnboarding, setDisplayName } from "@/lib/user-api";
import { installBlueprint } from "@/lib/explore-api";
import { useAccount } from "@/hooks/use-account";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { signedInWith } from "@/lib/shared-api";
import { useElementSize } from "@/hooks/use-element-size";
import { MailAddressField, useMailUsername } from "@/components/mail/MailAddressField";
import { createMailAddress, readMailBoxes } from "@/lib/mail-api";

/** Where Mail's step sits in the whole list, so a setup opened past it can step back when it is not offered. */
const MAIL_STEP = ONBOARDING_STEPS.findIndex((each) => each.id === 'mail');

/** Setup's steps: Mail's only where the deployment has mail and the person may create an address and has none. */
function stepsFor(mail: boolean): typeof ONBOARDING_STEPS[number][] {
  return ONBOARDING_STEPS.filter((each) => mail || each.id !== 'mail');
}

const SHOWCASE: { Icon: PhosphorIcon; title: string; copy: string }[] = [
  {
    Icon: SparkleIcon,
    title: 'Work that runs without you',
    copy: 'Give a workspace a task. The agent keeps working in the background, even with your device off, and you come back to a report.',
  },
  {
    Icon: AppWindowIcon,
    title: 'Live apps',
    copy: "A workspace can build a slate: a small live app you and your agents use together. Share one as a blueprint, or fork someone else's.",
  },
  {
    Icon: DesktopTowerIcon,
    title: 'Your machines, when you want them',
    copy: 'Link a machine with one command. An agent can use it only in the workspaces you allow, and its commands run in a sandbox unless you turn that off.',
  },
];

function stepDotCls(index: number, step: number): string {
  if (index === step) return 'w-8 bg-[var(--c-accent-fg)]';

  if (index < step) return 'w-4 bg-[var(--c-accent-fg)] opacity-40';

  return 'w-4 p-fill';
}

function ShowcaseStep({ revealed }: { revealed: boolean }) {
  return (
    <div className="space-y-3">
      {SHOWCASE.map(({ Icon, title, copy }, i) => (
        <div
          key={title}
          className={`flex items-start gap-3 rounded-xl border p-border p-surface p-4 transition-all duration-500 ${revealed ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}
          style={{ transitionDelay: `${i * 90}ms` }}
        >
          <div className="size-9 shrink-0 rounded-lg p-fill flex items-center justify-center">
            <Icon size={18} className="p-accent" />
          </div>
          <div>
            <div className="t-label p-text">{title}</div>
            <p className="t-meta p-text-3 mt-0.5">{copy}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function WelcomePage({ initialStep = 0 }: { initialStep?: number }) {
  const account = useAccount();
  const navigate = useNavigate();
  const profile = lastValue(account.profile);
  // Named so the empty field says why: production's one sign-in, Cloudflare, shares no name for most accounts.
  const provider = lastValue(useAsyncResource(signedInWith).resource);
  // Read once: the step stays offered while setup runs, even after it creates the address. Offered while it reads.
  const mail = useAsyncResource(readMailBoxes).resource;
  const mailBoxes = lastValue(mail);
  const offerMail = mail.status === "loading" || (mailBoxes?.enabled === true && mailBoxes.canCreate);
  const steps = stepsFor(offerMail);
  const LAST_STEP = steps.length - 1;
  // `?step=` names the step to open on: a sign-in that left this page returns to the step it left from.
  const [search] = useSearchParams();
  const opened = steps.findIndex((candidate) => candidate.id === search.get("step"));

  // `null` until touched, so a slow profile load never overwrites an edit.
  const [step, setStep] = useState(() => (opened >= 0 ? opened : Math.min(Math.max(0, initialStep), LAST_STEP)));
  const [reached, setReached] = useState(step);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  // Chosen when the step opens: Next installs it on Finish, and Not now leaves Home as it is.
  const [assistant, setAssistant] = useState<AssistantChoice>(DEFAULT_ASSISTANT);
  // Card height follows the active panel, observed; `h` 0 means unmeasured (no inline height).
  const stepSize = useElementSize();
  const stepHeight = stepSize.size.h === 0 ? null : stepSize.size.h;

  const displayName = name ?? profile?.displayName ?? '';
  // The name typed a step before is the one it is offered from.
  const address = useMailUsername(profile === null ? null : suggestedMailUsername({ displayName, email: profile.email }));
  const onMail = steps[step]?.id === 'mail';

  // Read as not offered after setup opened on a later step: the steps after it moved up one.
  useEffect(() => {
    if (mail.status !== "loading" && !offerMail) setStep((at) => (at > MAIL_STEP ? at - 1 : at));
  }, [mail.status, offerMail]);

  useEffect(() => setReached((most) => Math.max(most, step)), [step]);

  useEffect(() => {
    if (step === LAST_STEP) {
      const t = setTimeout(() => setRevealed(true), 30);

      return () => clearTimeout(t);
    }

    setRevealed(false);

    return undefined;
  }, [step, LAST_STEP]);

  // Same mark as the sidebar: first letter of the typed name, stored name, then email.
  const named = displayName.trim() || (profile?.email ?? '');
  const letter = (named === '' ? '?' : named)[0].toUpperCase();

  const finish = useCallback(() => detach(Effect.gen(function* () {
    setBusy(true);
    setError(null);

    return yield* Effect.catchCause(Effect.gen(function* () {
      // The assistant first: Home is its chat the moment setup ends.
      // Its brief keeps the blueprint's 08:00 in the person's own time zone; the time is changed in its settings.
      if (assistant.install) yield* Effect.promise(async () => installBlueprint(PERSONAL_ASSISTANT_ID, { displayName: assistant.name, agent: assistant.name, home: true }));
      const { onboardedAt } = yield* Effect.promise(async () => completeOnboarding());
      const current = lastValue(account.profile);

      // Publish the stamp before navigating so the gate doesn't bounce back to /welcome.
      if (current !== null) account.set({ ...current, onboardedAt });
      account.reload();
      yield* Effect.promise(async () => navigate(APP_ROUTES.home, { replace: true }));
    }), showing((chain) => {
      setError(chain);
      setBusy(false);
    }));
  })), [account, navigate, assistant]);

  const next = useCallback(() => settle(Effect.gen(function* () {
    setError(null);

    if (step === 0 && name !== null && name.trim() !== "" && name !== profile?.displayName) {
      setBusy(true);

      const failure = yield* Effect.matchCause(Effect.promise(() => setDisplayName(name)), {
        onSuccess: () => null,
        onFailure: (failed) => renderThrownChain({ cause: Cause.squash(failed) }),
      });

      setBusy(false);

      if (failure !== null) {
        setError(failure);

        return;
      }

      account.reload();
    }

    // Next is the address, made with its mailbox at once; the footer's Not now passes it by.
    if (onMail) {
      setBusy(true);

      const failure = yield* Effect.matchCause(Effect.promise(() => createMailAddress(address.username)), {
        onSuccess: () => null,
        onFailure: (failed) => renderThrownChain({ cause: Cause.squash(failed) }),
      });

      setBusy(false);

      if (failure !== null) {
        setError(failure);

        return;
      }
    }

    setStep((s) => Math.min(s + 1, LAST_STEP));
  })), [step, name, profile, account, onMail, address.username, LAST_STEP]);

  return (
    <div className="fixed inset-0 p-bg overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-8">
        <div className="mb-6 flex justify-center"><KinuLogo /></div>
        <h1 className="t-page-title text-center">Let's set up your account</h1>

        <ol aria-label="Setup steps" className="mt-6 mb-5 flex items-center justify-center gap-1.5">
          {steps.map((s, i) => (
            <li key={s.id} aria-current={i === step ? 'step' : undefined}>
              <span className={`block h-1.5 rounded-full transition-all ${stepDotCls(i, step)}`} />
            </li>
          ))}
        </ol>

        <section className="p-card overflow-hidden">
          <div
            className="overflow-hidden transition-[height] duration-300 ease-out"
            style={stepHeight === null ? undefined : { height: stepHeight }}
          >
          <div
            className="flex items-start transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${step * 100}%)` }}
          >
            {steps.map((s, i) => (
              <div
                key={s.id}
                className="w-full shrink-0 max-h-[62vh] overflow-y-auto px-5 py-5 sm:px-8 sm:py-7"
                data-welcome-step={s.id}
                aria-hidden={i !== step}
                inert={i !== step}
                ref={i === step ? stepSize.attach : undefined}
              >
                <h2 className="t-title p-text mb-5">{s.title}</h2>

                {s.id === 'profile' && (
                  <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                    <div data-avatar className="t-page-title size-16 rounded-full p-selected p-accent-mark flex items-center justify-center">
                      {letter}
                    </div>
                    <div className="w-full flex-1">
                      <DisplayNameField value={displayName} onChange={setName} saving={busy} bare />
                      {profile !== null && !profile.displayName && provider !== null && (
                        <p className="t-meta mt-2 p-text-3">{provider} didn't share a name.</p>
                      )}
                    </div>
                  </div>
                )}

                {s.id === 'mail' && (
                  <MailAddressField domain={mailBoxes?.domain ?? ''} username={address.username} state={address.state} onChange={address.setUsername} disabled={busy} />
                )}

                {s.id === 'providers' && (
                  <div className="space-y-5">
                    <ProvidersPanel framed={false} returnTo={`${APP_ROUTES.welcome}?step=${s.id}`} />
                  </div>
                )}

                {/* Mounted only while open, so a revisit reads the providers connected meanwhile. */}
                {s.id === 'model' && i === step && <DefaultModelField />}

                {/* Likewise: the model step writes the same catalog, so this one reads it when it opens. */}
                {s.id === 'search' && i === step && <WebSearchSettings place="setup" returnTo={`${APP_ROUTES.welcome}?step=${s.id}`} />}

                {s.id === 'tools' && (
                  <div className="space-y-4">
                    <p className="t-body p-text-3">MCP servers give every agent you own their tools. Connect one now, or any time in settings.</p>
                    {i <= reached && <McpServersSection />}
                  </div>
                )}

                {s.id === 'assistant' && <AssistantStep choice={assistant} onChange={setAssistant} person={personName(profile === null ? null : { displayName, email: profile.email })} />}

                {s.id === 'showcase' && <ShowcaseStep revealed={revealed} />}
              </div>
            ))}
          </div>
          </div>

          {error && <p className="t-meta p-danger px-5 sm:px-8 pt-3">{error}</p>}

          <div className="flex items-center justify-between gap-3 border-t p-border px-5 py-4 sm:px-8">
            {step > 0 ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStep((s) => s - 1)}>Back</Button>
            ) : <span />}

            {step < LAST_STEP ? (
              <div className="flex items-center gap-3">
                <button type="button" disabled={busy} onClick={finish}
                  className={buttonClass({ variant: "ghost" })}>
                  Skip setup
                </button>
                {onMail && <Button variant="ghost" size="sm" data-mail-not-now disabled={busy} onClick={() => setStep((s) => Math.min(s + 1, LAST_STEP))}>Not now</Button>}
                <Button variant="primary" size="md" disabled={busy || (onMail && address.state !== "available")} onClick={(...args: Parameters<typeof next>) => detach(Effect.promise(async () => next(...args)))}>
                  {busy && <Loader size="sm" />} Next
                </Button>
              </div>
            ) : (
              <Button variant="primary" size="md" disabled={busy} onClick={finish}>
                {busy && <Loader size="sm" />} Finish setup
              </Button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
