/** Settings, Beta: off until turned on, in the profile catalog both backends read. */
import { useState } from "react";
import { GraphIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import { betaSwarms, SWARMS_BETA_SETTING, type ProfileCatalogEnvelope } from "@kinu.run/core";
import { attempt, renderThrownChain, detach } from "@kinu.run/core/obs";
import { Card, Field } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { getProfileCatalog, updateProfileCatalog } from "../lib/user-api";

export function BetaSettings() {
  const { resource, reload, set } = useAsyncResource(getProfileCatalog);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const turn = (envelope: ProfileCatalogEnvelope, on: boolean) => {
    setSaving(true);
    setFailure(null);

    return attempt({ doing: `turning ${on ? "on" : "off"} ${SWARMS_BETA_SETTING}`, otherwise: "io" },
      () => updateProfileCatalog({ ...envelope.catalog, betaSwarms: on }, envelope.version)).pipe(
      Effect.map(set),
      Effect.catch((failed) => Effect.sync(() => {
        setFailure(renderThrownChain({ cause: failed }));
        reload();
      })),
      Effect.ensuring(Effect.sync(() => { setSaving(false); })),
    );
  };

  return (
    <Card title="Swarms" icon={GraphIcon}
      description="An agent runs many short-lived nodes in parallel to explore a question, then judges what they found. Off, agents are not offered swarms and the Swarms tab is hidden.">
      <CardSlot resource={resource} what="your beta settings" onRetry={reload}>
        {(envelope) => {
          const on = betaSwarms(envelope.catalog);

          return (
            <Field label={SWARMS_BETA_SETTING} hint={failure ?? (saving ? "Saving…" : "Applies from each workspace's next turn.")} inline>
              <button
                type="button"
                role="switch"
                data-beta-swarms
                aria-checked={on}
                aria-label={SWARMS_BETA_SETTING}
                disabled={saving}
                onClick={() => detach(turn(envelope, !on))}
                className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
                  on ? "border-[var(--c-accent)] bg-[var(--c-accent)]" : "border-[var(--c-border-strong)] bg-[var(--c-fill)]"
                }`}
              >
                <span className={`size-3 rounded-full transition-transform ${
                  on ? "translate-x-3 bg-[var(--c-accent-on)]" : "translate-x-0.5 bg-[var(--c-text-3)]"
                }`} />
              </button>
            </Field>
          );
        }}
      </CardSlot>
    </Card>
  );
}
