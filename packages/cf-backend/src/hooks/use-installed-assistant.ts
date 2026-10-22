import { readInstalledAssistant } from "@/lib/explore-api";
import { useAsyncResource, type AsyncResource } from "./use-async-resource";
import { useGallerySignedIn } from "./use-gallery-signed-in";

const VISITOR_HAS_NONE = (): Promise<string | null> => Promise.resolve(null);

/** The workspace Home opens on: the owner's Personal assistant, or null while they have none, as a visitor signed out has. */
export function useInstalledAssistant(): AsyncResource<string | null> {
  return useAsyncResource(useGallerySignedIn() ? readInstalledAssistant : VISITOR_HAS_NONE).resource;
}
