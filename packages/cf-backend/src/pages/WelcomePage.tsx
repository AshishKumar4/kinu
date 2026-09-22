/** First-run setup wizard; an unfinished account lands here from any URL. */
import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import {
  AppWindowIcon, DesktopTowerIcon, SparkleIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import {
  APP_ROUTES, ONBOARDING_STEPS,
} from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { DisplayNameField } from "@/components/account/DisplayNameField";
import { ProvidersPanel } from "@/components/account/ProvidersPanel";
import { completeOnboarding, setDisplayName } from "@/lib/user-api";
import { useAccount } from "@/hooks/use-account";
import { lastValue } from "@/hooks/use-async-resource";
import { useElementSize } from "@/hooks/use-element-size";

const LAST_STEP = ONBOARDING_STEPS.length - 1;

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
            <div className="text-sm font-semibold p-text">{title}</div>
            <p className="p-meta p-text-3 mt-0.5">{copy}</p>
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

  // `null` until touched, so a slow profile load never overwrites an edit.
  const [step, setStep] = useState(() => Math.min(Math.max(0, initialStep), LAST_STEP));
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  // Card height follows the active panel, observed; `h` 0 means unmeasured (no inline height).
  const stepSize = useElementSize();
  const stepHeight = stepSize.size.h === 0 ? null : stepSize.size.h;

  const displayName = name ?? profile?.displayName ?? '';

  useEffect(() => {
    if (step === LAST_STEP) {
      const t = setTimeout(() => setRevealed(true), 30);

      return () => clearTimeout(t);
    }

    setRevealed(false);

    return undefined;
  }, [step]);

  // Same mark as the sidebar: first letter of the typed name, stored name, then email.
  const named = displayName.trim() || (profile?.email ?? '');
  const letter = (named === '' ? '?' : named)[0].toUpperCase();

  const finish = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const { onboardedAt } = await completeOnboarding();
      const current = lastValue(account.profile);

      // Publish the stamp before navigating so the gate doesn't bounce back to /welcome.
      if (current !== null) account.set({ ...current, onboardedAt });
      account.reload();
      await navigate(APP_ROUTES.home, { replace: true });
    } catch (cause) {
      setError(renderThrownChain({ cause }));
      setBusy(false);
    }
  }, [account, navigate]);

  const next = useCallback(async () => {
    setError(null);

    if (step === 0 && name !== null && name !== profile?.displayName) {
      setBusy(true);
      const failure = await setDisplayName(name).then(() => null, (...rejection: [unknown]) => renderThrownChain({ cause: rejection[0] }));
      setBusy(false);

      if (failure !== null) {
        setError(failure);

        return;
      }

      account.reload();
    }

    setStep((s) => Math.min(s + 1, LAST_STEP));
  }, [step, name, profile, account]);

  return (
    <div className="fixed inset-0 p-bg overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-8">
        <div className="mb-6 flex justify-center"><KinuLogo /></div>
        <h1 className="p-display text-[26px] leading-8 text-center">Let's set up your account</h1>

        <ol aria-label="Setup steps" className="mt-6 mb-5 flex items-center justify-center gap-1.5">
          {ONBOARDING_STEPS.map((s, i) => (
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
            {ONBOARDING_STEPS.map((s, i) => (
              <div
                key={s.id}
                className="w-full shrink-0 max-h-[62vh] overflow-y-auto px-5 py-5 sm:px-8 sm:py-7"
                data-welcome-step={s.id}
                aria-hidden={i !== step}
                inert={i !== step}
                ref={i === step ? stepSize.attach : undefined}
              >
                <h2 className="p-title p-text mb-5">{s.title}</h2>

                {s.id === 'profile' && (
                  <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                    <div className="size-16 rounded-full bg-[#2A2018] text-[22px] font-semibold text-[var(--c-accent)] flex items-center justify-center">
                      {letter}
                    </div>
                    <div className="w-full flex-1">
                      <DisplayNameField value={displayName} onChange={setName} saving={busy} />
                    </div>
                  </div>
                )}

                {s.id === 'model' && (
                  <div className="space-y-5">
                    <ProvidersPanel returnTo={APP_ROUTES.welcome} />
                  </div>
                )}

                {s.id === 'showcase' && <ShowcaseStep revealed={revealed} />}
              </div>
            ))}
          </div>
          </div>

          {error && <p className="text-xs p-danger px-5 sm:px-8 pt-3">{error}</p>}

          <div className="flex items-center justify-between gap-3 border-t p-border px-5 py-4 sm:px-8">
            {step > 0 ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStep((s) => s - 1)}>Back</Button>
            ) : <span />}

            {step < LAST_STEP ? (
              <div className="flex items-center gap-3">
                <button type="button" disabled={busy} onClick={finish}
                  className="p-btn-ghost inline-flex h-6.5 items-center rounded-md px-2 text-xs">
                  Skip setup
                </button>
                <FilledButton disabled={busy} onClick={next}>
                  {busy && <Loader size="sm" />} Next
                </FilledButton>
              </div>
            ) : (
              <FilledButton disabled={busy} onClick={finish}>
                {busy && <Loader size="sm" />} Finish setup
              </FilledButton>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
