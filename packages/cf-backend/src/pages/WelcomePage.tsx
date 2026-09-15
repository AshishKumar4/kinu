/**
 * First-run setup — the four-step wizard an account that has never finished it
 * lands on, whatever URL it arrived at.
 *
 * The panels are the account's own, shared with settings and the setup card:
 * step 2 mounts `McpServersPanel` and `CliInstallCard` whole, so a server
 * added during onboarding is the same server settings would list, and the CLI
 * command the wizard shows is the same one the cli section copies.
 */
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
import { McpServersPanel } from "@/components/account/McpServersPanel";
import { CliInstallCard } from "@/components/account/CliInstallCard";
import { ProfileCatalogSettings } from "@/components/ProfileCatalogSettings";
import { completeOnboarding, setDisplayName } from "@/lib/user-api";
import { useAccount } from "@/hooks/use-account";
import { lastValue } from "@/hooks/use-async-resource";
import { useElementSize } from "@/hooks/use-element-size";

const LAST_STEP = ONBOARDING_STEPS.length - 1;

/** Step 3 — what Kinu does. The three cards fade in on arrival, each a beat
 *  after the last, so the step reads as revealed rather than already there. */
const SHOWCASE: { Icon: PhosphorIcon; title: string; copy: string }[] = [
  {
    Icon: SparkleIcon,
    title: 'Work that runs without you',
    copy: 'Give a workspace a mission. It researches, writes and tests code, and keeps going in the background. Come back to a report, not a chat you have to babysit.',
  },
  {
    Icon: AppWindowIcon,
    title: 'Live apps, not just answers',
    copy: "A workspace can build a slate: a small live app you and your agents use together. Share one as a blueprint, or fork someone else's.",
  },
  {
    Icon: DesktopTowerIcon,
    title: 'Your machines, when you want them',
    copy: 'Link a laptop or a server with one command. Agents can use it when you allow it, sandboxed by default.',
  },
];

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

  const [step, setStep] = useState(() => Math.min(Math.max(0, initialStep), LAST_STEP));
  // `null` until the field is touched: the displayed name follows the loaded
  // profile until the user types, so a slow profile never overwrites an edit.
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  // The card follows the step it is showing: the track is as wide as all four
  // panels, but its height is the ACTIVE panel's, observed rather than
  // guessed, so step 0 is not a 62vh card over a void. `attach` re-binds the
  // observer whenever `step` changes; `h` stays 0 ("not measured") until the
  // first callback, and an unmeasured wrapper means no inline height at all.
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

  // The onboarding mark is the SAME mark the sidebar shows: first letter of
  // the name being typed, then of the stored name, then of the email.
  const letter = (displayName.trim() || profile?.email || '?')[0].toUpperCase();

  const finish = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const { onboardedAt } = await completeOnboarding();
      const current = lastValue(account.profile);

      // The gate reads the SHARED profile: publishing the stamp before the
      // navigation is what keeps it from bouncing the route back to /welcome
      // while the reload is still in flight.
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

      try {
        await setDisplayName(name);
        account.reload();
      } catch (cause) {
        setError(renderThrownChain({ cause }));
        setBusy(false);

        return;
      }

      setBusy(false);
    }

    setStep((s) => Math.min(s + 1, LAST_STEP));
  }, [step, name, profile, account]);

  return (
    <div className="fixed inset-0 p-bg overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-8">
        <div className="mb-6 flex justify-center"><KinuLogo /></div>
        <h1 className="p-display text-[26px] leading-8 text-center">Let's set up your account</h1>
        <p className="p-row-text p-text-3 text-center mt-2">
          A few things before your first workspace. Everything here can be changed later in Account settings.
        </p>

        <ol aria-label="Setup steps" className="mt-6 mb-5 flex items-center justify-center gap-1.5">
          {ONBOARDING_STEPS.map((s, i) => (
            <li key={s.id} aria-current={i === step ? 'step' : undefined}>
              <span
                className={`block h-1.5 rounded-full transition-all ${
                  i === step ? 'w-8 bg-[var(--c-accent-fg)]'
                    : i < step ? 'w-4 bg-[var(--c-accent-fg)] opacity-40'
                      : 'w-4 p-fill'
                }`}
              />
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
                <h2 className="p-title p-text">{s.title}</h2>
                <p className="p-meta p-text-3 mb-5">{s.lede}</p>

                {s.id === 'profile' && (
                  <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="size-16 rounded-full bg-[#2A2018] text-[22px] font-semibold text-[var(--c-accent)] flex items-center justify-center">
                        {letter}
                      </div>
                      <p className="p-meta p-text-3 text-center max-w-28">This is the mark every surface shows you as.</p>
                    </div>
                    <div className="w-full flex-1">
                      <DisplayNameField value={displayName} onChange={setName} saving={busy} />
                    </div>
                  </div>
                )}

                {s.id === 'model' && (
                  <div className="space-y-5">
                    <ProvidersPanel returnTo={APP_ROUTES.welcome} />
                    <ProfileCatalogSettings tiersOnly />
                  </div>
                )}

                {s.id === 'connections' && (
                  <div className="space-y-5">
                    <McpServersPanel />
                    <CliInstallCard />
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
                {busy && <Loader size="sm" />} Create your first workspace
              </FilledButton>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
