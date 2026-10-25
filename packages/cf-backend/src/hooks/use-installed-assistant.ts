import { readInstalledAssistant } from "@/lib/explore-api";
import { useSetupFinish } from "@/lib/setup-finish";
import { useAsyncResource, type AsyncResource } from "./use-async-resource";
import { useGallerySignedIn } from "./use-gallery-signed-in";

const VISITOR_HAS_NONE = (): Promise<string | null> => Promise.resolve(null);

/** The workspace Home opens on: the owner's Personal assistant, or null while they have none, as a visitor signed out has.
 *  One setup installed on this page is known as it lands, without reading the account again. */
export function useInstalledAssistant(): AsyncResource<string | null> {
  const read = useAsyncResource(useGallerySignedIn() ? readInstalledAssistant : VISITOR_HAS_NONE).resource;
  const installed = useSetupFinish()?.assistant;

  return installed?.state === "installed" ? { status: "ready", value: installed.workspace } : read;
}
