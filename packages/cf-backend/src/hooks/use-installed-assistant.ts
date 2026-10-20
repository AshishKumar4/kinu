import { readInstalledAssistant } from "@/lib/explore-api";
import { useAsyncResource, type AsyncResource } from "./use-async-resource";

/** The workspace Home opens on: the owner's Personal assistant, or null while they have none. */
export function useInstalledAssistant(): AsyncResource<string | null> {
  return useAsyncResource(readInstalledAssistant).resource;
}
