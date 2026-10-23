import { Effect } from "effect";
import { useCallback, useState } from "react";
import { Loader } from "@/components/ui/Loader";
import { retargetedTier, specWithoutAccount, type ModelMenuResponse, type ProfileCatalogEnvelope } from "@kinu.run/core";
import { detach, showing } from "@kinu.run/core/obs";
import { ModelPicker } from "@/components/ModelPicker";
import { CardSlot } from "@/components/ui/CardSlot";
import { getProfileCatalog, listAvailableModels, updateProfileCatalog } from "@/lib/user-api";
import { useAsyncResource } from "@/hooks/use-async-resource";

export function DefaultModelField() {
  const catalog = useAsyncResource(getProfileCatalog);
  const menu = useAsyncResource(listAvailableModels);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadCatalog = catalog.reload;
  const reloadMenu = menu.reload;
  const publish = catalog.set;

  const choose = useCallback((envelope: ProfileCatalogEnvelope, listing: ModelMenuResponse, model: string) => {
    const declared = listing.models.find((entry) => entry.spec === specWithoutAccount(model))?.reasoningEfforts;
    const tiers = { ...envelope.catalog.tiers, default: retargetedTier(envelope.catalog.tiers.default, model, declared) };

    setSaving(true);
    setError(null);
    detach(Effect.ensuring(
      Effect.catchCause(Effect.gen(function* () {
        publish(yield* Effect.promise(() => updateProfileCatalog({ ...envelope.catalog, tiers }, envelope.version)));
      }), showing(setError)),
      Effect.sync(() => setSaving(false)),
    ));
  }, [publish]);

  const retry = () => { reloadCatalog(); reloadMenu(); };

  return (
    <CardSlot resource={catalog.resource} what="your default model" onRetry={retry}>
      {(envelope) => (
        <CardSlot resource={menu.resource} what="your connected models" onRetry={retry}>
          {(models) => (models.models.length === 0 ? (
            <p className="t-body p-text-3" data-default-model="none">
              No models yet. Connect a provider in the step before and its models show up here.
            </p>
          ) : (
            <div className="space-y-2" data-default-model={envelope.catalog.tiers.default.model}>
              <ModelPicker models={models.models} failures={models.failures} accounts={models.accounts}
                value={envelope.catalog.tiers.default.model} onChange={(model) => choose(envelope, models, model)}
                label="Default model" className="w-full" disabled={saving} />
              <p className="t-meta p-text-3 flex items-center gap-2">
                {saving && <Loader size="sm" />}
                {saving ? "Saving…" : "Every new workspace starts on this model. You can change it per workspace, or later in settings."}
              </p>
              {error && <p className="t-meta p-danger">{error}</p>}
            </div>
          ))}
        </CardSlot>
      )}
    </CardSlot>
  );
}
