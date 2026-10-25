/** First-run setup wizard; an unfinished account lands here from any URL. */
import { Cause, Effect } from 'effect';
import { useState, useCallback, useEffect, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import {
  AppWindowIcon, DesktopTowerIcon, SparkleIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import {
  APP_ROUTES, ONBOARDING_STEPS, personName, suggestedMailUsername,
} from "@kinu.run/core";
import { renderThrownChain, settle, detach } from "@kinu.run/core/obs";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { DisplayNameField } from "@/components/account/DisplayNameField";
import { ProvidersPanel } from "@/components/account/ProvidersPanel";
import { DefaultModelField } from "@/components/account/DefaultModelField";
import { WebSearchSettings } from "@/components/account/WebSearchSettings";
import { AssistantStep, DEFAULT_ASSISTANT, type AssistantChoice } from "@/components/assistant/AssistantStep";
import { McpServersSection } from "@/components/account/McpServersPanel";
import { setDisplayName } from "@/lib/user-api";
import { finishSetup } from "@/lib/setup-finish";
import { useAccount } from "@/hooks/use-account";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { signedInWith } from "@/lib/shared-api";
import { useElementSize } from "@/hooks/use-element-size";
import { MailAddressField, useMailUsername } from "@/components/mail/MailAddressField";
import { createMailAddress, readMailBoxes } from "@/lib/mail-api";
import { Surface } from "@/components/ui/Surface";
import { StepDots } from "@/components/ui/Meter";


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

/** The `i`th card's place in the reveal (`p-reveal-step`). */
function revealAt(i: number): CSSProperties & { readonly "--reveal-step": string } {
  return { "--reveal-step": String(i) };
}

function ShowcaseStep({ revealed }: { revealed: boolean }) {
  return (
    <div className="space-y-3">
      {SHOWCASE.map(({ Icon, title, copy }, i) => (
        <Surface
          look="panel"
          key={title}
          className={`p-reveal-step flex items-start gap-3 p-4 transition-all duration-500 ${revealed ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}
          style={revealAt(i)}
        >
          <Surface look="tile" className="size-9 shrink-0 flex items-center justify-center">
            <Icon size={18} className="p-accent-fg" />
          </Surface>
          <div>
            <div className="t-label p-text">{title}</div>
            <p className="t-meta p-text-3 mt-px">{copy}</p>
          </div>
        </Surface>
      ))}
    </div>
  );
}

/**
 * The step setup shows, held in the address by its id (`?step=`): a connect run in this tab comes back to it, and a step
 * keeps its place when Mail turns out not to be offered. Opened on no step it names, it shows `initialStep` and writes
 * it down while Mail is still counted. `goTo` replaces the address rather than pushing: Back is the wizard's own button,
 * and the browser's leaves setup.
 */
function useAddressedStep(offerMail: boolean, initialStep: number) {
  const steps = stepsFor(offerMail);
  const [search, setSearch] = useSearchParams();
  // A step it names that is not offered, Mail read as not offered after all, gives way to the step after it.
  const named = ONBOARDING_STEPS.findIndex((candidate) => candidate.id === search.get("step"));
  const addressed = named < 0 ? -1 : steps.findIndex((candidate) => ONBOARDING_STEPS.indexOf(candidate) >= named);
  const step = addressed >= 0 ? addressed : Math.min(Math.max(0, initialStep), steps.length - 1);

  const goTo = useCallback((index: number) => {
    const id = stepsFor(offerMail)[index]?.id;

    if (id === undefined) return;

    setSearch((at) => {
      at.set("step", id);

      return at;
    }, { replace: true });
  }, [offerMail, setSearch]);

  useEffect(() => { if (addressed < 0) goTo(step); }, [addressed, step, goTo]);

  return { step, goTo };
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
  const { step, goTo } = useAddressedStep(offerMail, initialStep);
  const [reached, setReached] = useState(step);
  // `null` until touched, so a slow profile load never overwrites an edit.
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

  // Home at once (the owner, 2026-10-25: "not snappy"): the stamp and the assistant's install finish behind it
  // (`finishSetup`), Home shows the assistant arriving, and a failure is said on the page the person is on.
  const finish = useCallback(() => {
    const current = lastValue(account.profile);

    // Stamped here as the server will stamp it, so the gate lets Home through; the server's own replaces it.
    if (current !== null && current.onboardedAt === null) account.set({ ...current, onboardedAt: Date.now() });
    detach(finishSetup(assistant.install ? assistant.name : null, () => account.reload()));
    detach(Effect.promise(async () => navigate(APP_ROUTES.home, { replace: true })));
  }, [account, navigate, assistant]);

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

    goTo(Math.min(step + 1, LAST_STEP));
  })), [step, name, profile, account, onMail, address.username, LAST_STEP, goTo]);

  return (
    <Surface look="page" className="fixed inset-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-8">
        <div className="mb-6 flex justify-center"><KinuLogo /></div>
        <h1 className="t-page-title text-center">Let's set up your account</h1>

        <div className="mt-6 mb-5"><StepDots label="Setup steps" steps={steps.map((s) => s.id)} at={step} /></div>

        <Surface look="panel" as="section" className="overflow-hidden">
          <div
            className="p-welcome-frame overflow-hidden"
            style={stepHeight === null ? undefined : { height: stepHeight }}
          >
          <div
            className="flex items-start transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${step * 100}%)` }}
          >
            {steps.map((s, i) => (
              <div
                key={s.id}
                className="w-full shrink-0 max-h-[var(--layout-welcome-step)] overflow-y-auto px-5 py-5 sm:px-8 sm:py-6"
                data-welcome-step={s.id}
                aria-hidden={i !== step}
                inert={i !== step}
                ref={i === step ? stepSize.attach : undefined}
              >
                <h2 className="t-title p-text mb-5">{s.title}</h2>

                {s.id === 'profile' && (
                  <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                    <Surface round look="selected" className="t-page-title size-16 p-accent-mark flex items-center justify-center" data-avatar>
                      {letter}
                    </Surface>
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
                    <ProvidersPanel framed={false} />
                  </div>
                )}

                {/* Mounted only while open, so a revisit reads the providers connected meanwhile. */}
                {s.id === 'model' && i === step && <DefaultModelField />}

                {/* Likewise: the model step writes the same catalog, so this one reads it when it opens. */}
                {s.id === 'search' && i === step && <WebSearchSettings place="setup" />}

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
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => goTo(step - 1)}>Back</Button>
            ) : <span />}

            {step < LAST_STEP ? (
              <div className="flex items-center gap-3">
                <Button variant="ghost" disabled={busy} onClick={finish}>
                  Skip setup
                </Button>
                {onMail && <Button variant="ghost" size="sm" data-mail-not-now disabled={busy} onClick={() => goTo(Math.min(step + 1, LAST_STEP))}>Not now</Button>}
                <Button variant="primary" size="md" disabled={busy || (onMail && address.state !== "available")} onClick={(...args: Parameters<typeof next>) => detach(Effect.promise(async () => next(...args)))}>
                  {busy && <Loader size="sm" />} Next
                </Button>
              </div>
            ) : (
              <Button variant="primary" size="md" disabled={busy} onClick={finish}>Finish setup</Button>
            )}
          </div>
        </Surface>
      </div>
    </Surface>
  );
}
