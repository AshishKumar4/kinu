/**
 * Settings → Appearance: the account's theme, which the server names on every page it serves this account, and this
 * device's mode and alerts (use-owner-alerts.ts). Each theme is offered as a swatch drawn in its own tokens, in the mode
 * the page is in. The section's own header titles it, so the card carries no header of its own.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Effect } from "effect";
import { THEME_NAMES, type ThemeName } from "@kinu.run/core";
import { attempt, detach, renderThrownChain } from "@kinu.run/core/obs";
import { Field } from "@/components/ui/form";
import { Switch } from "@/components/ui/Switch";
import { Card } from "@/components/ui/Card";
import { Choices } from "@/components/ui/Choices";
import { Segmented } from "@/components/ui/Segmented";
import { ThemeSwatch } from "@/components/ui/ThemeSwatch";
import { setAlertSound, useAlertSound } from "@/hooks/use-owner-alerts";
import { setMode, useTheme, wearTheme, type ThemeMode } from "@/hooks/use-theme";
import { setAccountTheme } from "../../lib/user-api";

/** A look's name; its swatch shows what it is (design review 2026-10-20, F6: no line describing it). */
const THEMES: Readonly<Record<ThemeName, { readonly label: string }>> = {
  graphite: { label: "Graphite" },
  warm: { label: "Warm" },
};

const MODES: readonly { readonly id: ThemeMode; readonly label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** The browser's word on notifications for this site, asked for once the owner presses Allow. */
function NotificationsField() {
  const [permission, setPermission] = useState(() => ("Notification" in window ? Notification.permission : null));

  if (permission === null) return null;

  const hint = { default: undefined, granted: undefined, denied: "Blocked in this browser's settings for this site." }[permission];

  return (
    <Field label="Notifications" hint={hint} inline>
      {permission === "default" && (
        <Button size="sm" variant="secondary" data-alerts-allow
          onClick={() => detach(Effect.map(Effect.promise(() => Notification.requestPermission()), setPermission))}>Allow</Button>
      )}
    </Field>
  );
}

function AlertFields() {
  const sound = useAlertSound();

  return (
    <>
      <Field label="Sound" inline>
        <Switch on={sound} onChange={setAlertSound} label="Sound" data-alerts-sound />
      </Field>
      <NotificationsField />
    </>
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
    <Card>
      <Field label="Theme" hint={failure ?? (saving === null ? undefined : `Saving ${THEMES[saving].label}…`)}>
        <Choices tiles label="Theme" marker="data-theme-choice" value={name} disabled={saving !== null} onChange={(theme) => detach(choose(theme))}
          options={THEME_NAMES.map((theme) => ({
            id: theme,
            label: THEMES[theme].label,
            picture: <ThemeSwatch theme={theme} mode={mode} />,
            aside: name === theme ? <span className="t-meta p-accent-fg">In use</span> : undefined,
          }))} />
      </Field>
      <Field label="Mode" inline>
        <Segmented label="Mode" segments={MODES} value={mode} onChange={setMode} />
      </Field>
      <AlertFields />
    </Card>
  );
}
