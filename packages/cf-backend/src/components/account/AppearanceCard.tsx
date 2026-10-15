/**
 * Settings → Appearance: the account's theme, which the server names on every page it serves this account, and this
 * device's mode. Each theme is offered as a swatch drawn in its own tokens, in the mode the page is in. The section's
 * own header titles it, so the card carries no header of its own.
 */
import { useState } from "react";
import { Effect } from "effect";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { THEME_NAMES, type ThemeName } from "@kinu.run/core";
import { attempt, detach, renderThrownChain } from "@kinu.run/core/obs";
import { Field } from "@/components/ui/form";
import { setMode, useTheme, wearTheme, type ThemeMode } from "@/hooks/use-theme";
import { setAccountTheme } from "../../lib/user-api";

const THEMES: Readonly<Record<ThemeName, { readonly label: string; readonly about: string }>> = {
  graphite: { label: "Graphite", about: "Near-neutral greys. Brass is the only colour on screen." },
  warm: { label: "Warm", about: "Kinu's umber and paper, with clearer contrast." },
};

const MODES: readonly { readonly id: ThemeMode; readonly label: string; readonly Icon: typeof SunIcon }[] = [
  { id: "light", label: "Light", Icon: SunIcon },
  { id: "dark", label: "Dark", Icon: MoonIcon },
];

/** A page in miniature: rail, ground, a card with two lines of text and a brass action. */
function Swatch({ theme, mode }: { theme: ThemeName; mode: ThemeMode }) {
  return (
    <span data-theme={theme} data-mode={mode} aria-hidden="true"
      className="flex h-[84px] overflow-hidden rounded-[10px] border border-[var(--c-border)] bg-[var(--c-bg)]">
      <span className="flex w-[26%] flex-col gap-1.5 border-r border-[var(--c-border)] bg-[var(--c-sidebar)] p-2">
        <span className="h-1.5 w-3/4 rounded-full bg-[var(--c-accent-subtle)]" />
        <span className="h-1.5 w-1/2 rounded-full bg-[var(--c-neutral-tint)]" />
        <span className="h-1.5 w-2/3 rounded-full bg-[var(--c-neutral-tint)]" />
      </span>
      <span className="flex flex-1 flex-col justify-center p-2.5">
        <span className="flex flex-col gap-1.5 rounded-md border border-[var(--c-border)] bg-[var(--c-surface)] p-2">
          <span className="h-1.5 w-4/5 rounded-full bg-[var(--c-text)]" />
          <span className="h-1.5 w-3/5 rounded-full bg-[var(--c-text-3)]" />
          <span className="mt-0.5 h-2.5 w-8 self-end rounded-full bg-[var(--c-accent)]" />
        </span>
      </span>
    </span>
  );
}

export function AppearanceCard() {
  const { mode, name } = useTheme();
  const [saving, setSaving] = useState<ThemeName | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const choose = (theme: ThemeName) => {
    setSaving(theme);
    setFailure(null);

    return attempt({ doing: "saving your theme", otherwise: "io" }, () => setAccountTheme(theme)).pipe(
      Effect.map(() => { wearTheme(theme); }),
      Effect.catch((failed) => Effect.sync(() => { setFailure(renderThrownChain({ cause: failed.cause ?? failed })); })),
      Effect.ensuring(Effect.sync(() => { setSaving(null); })),
    );
  };

  return (
    <section className="p-card overflow-hidden">
      <div className="space-y-6 px-5 py-5">
        <Field label="Theme" hint={failure ?? (saving === null ? undefined : `Saving ${THEMES[saving].label}…`)}>
          <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-2">
            {THEME_NAMES.map((theme) => (
              <label key={theme} data-theme-choice={theme}
                className="group relative block cursor-pointer rounded-[14px] border p-border p-2 transition-colors hover:border-[var(--c-border-strong)] has-[:checked]:border-[var(--c-accent)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--c-accent-subtle)] has-[:disabled]:cursor-default">
                <input type="radio" name="theme" value={theme} checked={name === theme} disabled={saving !== null}
                  onChange={() => detach(choose(theme))} className="sr-only" />
                <Swatch theme={theme} mode={mode} />
                <span className="mt-2 flex items-baseline justify-between gap-2 px-1">
                  <span className="p-row-text font-medium p-text">{THEMES[theme].label}</span>
                  {name === theme && <span className="p-meta p-accent">In use</span>}
                </span>
                <span className="mt-0.5 block px-1 pb-1 p-meta p-text-3">{THEMES[theme].about}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Mode" hint="On this device." inline>
          <div role="radiogroup" aria-label="Mode" className="flex items-center gap-0.5 rounded-lg p-recessed p-0.5">
            {MODES.map(({ id, label, Icon }) => (
              <label key={id} className="cursor-pointer">
                <input type="radio" name="mode" value={id} checked={mode === id} onChange={() => setMode(id)} className="peer sr-only" />
                <span className="flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium p-text-3 transition-colors peer-checked:bg-[var(--c-surface)] peer-checked:p-text peer-checked:shadow-[0_0_0_1px_var(--c-border)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--c-accent-subtle)] hover:p-text">
                  <Icon size={13} />{label}
                </span>
              </label>
            ))}
          </div>
        </Field>
      </div>
    </section>
  );
}
