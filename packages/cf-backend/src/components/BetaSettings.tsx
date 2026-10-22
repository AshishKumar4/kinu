/** Settings, Beta: off until turned on, in the profile catalog both backends read. */
import { useState } from "react";
import { Effect } from "effect";
import { betaSwarms, SWARMS_BETA_SETTING, type ProfileCatalogEnvelope } from "@kinu.run/core";
import { attempt, renderThrownChain, detach } from "@kinu.run/core/obs";
import { Card, Field } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { Switch } from "@/components/ui/Switch";
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
    <Card title="Swarms">
      <CardSlot resource={resource} what="your beta settings" onRetry={reload}>
        {(envelope) => {
          const on = betaSwarms(envelope.catalog);

          return (
            <Field label="Use swarms" hint={failure ?? (saving ? "Saving…" : undefined)} inline>
              <Switch on={on} onChange={(next) => detach(turn(envelope, next))} label={SWARMS_BETA_SETTING} disabled={saving} data-beta-swarms />
            </Field>
          );
        }}
      </CardSlot>
    </Card>
  );
}
