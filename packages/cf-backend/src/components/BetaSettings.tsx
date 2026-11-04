/** Settings, Beta: off until turned on, in the profile catalog both backends read. */
import { Effect } from "effect";
import { betaSwarms, SWARMS_BETA_SETTING, type ProfileCatalogEnvelope } from "@kinu.run/core";
import { attempt } from "@kinu.run/core/obs";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { CardSlot } from "@/components/ui/CardSlot";
import { Switch } from "@/components/ui/Switch";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { useLabelledStep } from "@/hooks/use-labelled-step";
import { getProfileCatalog, updateProfileCatalog } from "../lib/user-api";

export function BetaSettings() {
  const { resource, reload, set } = useAsyncResource(getProfileCatalog);
  // A refused turn reads the stored setting again, so the switch shows what holds.
  const { busy, error: failure, run } = useLabelledStep();
  const saving = busy !== null;

  const turn = (envelope: ProfileCatalogEnvelope, on: boolean): void => run("turn", () => Effect.map(
    Effect.tapError(attempt({ doing: `turning ${on ? "on" : "off"} ${SWARMS_BETA_SETTING}`, otherwise: "io" },
      () => updateProfileCatalog({ ...envelope.catalog, betaSwarms: on }, envelope.version)), () => Effect.sync(reload)),
    set,
  ));

  return (
    <Card title="Swarms">
      <CardSlot resource={resource} what="your beta settings" onRetry={reload}>
        {(envelope) => {
          const on = betaSwarms(envelope.catalog);

          return (
            <Field label="Use swarms" hint={failure ?? (saving ? "Saving…" : undefined)} inline>
              <Switch on={on} onChange={(next) => turn(envelope, next)} label={SWARMS_BETA_SETTING} disabled={saving} data-beta-swarms />
            </Field>
          );
        }}
      </CardSlot>
    </Card>
  );
}
