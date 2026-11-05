/** A read of the deploy door as the page shows it: while it is asked, once it is answered, or once it is refused. */
import { lastValue, type AsyncResource } from "@/hooks/use-async-resource";
import type { DeployHeard, DeployRefused } from "@/lib/deploy-page-api";

export type Reading<A> =
  | { readonly state: "reading" }
  | { readonly state: "read"; readonly answer: A }
  | { readonly state: "refused"; readonly refusal: DeployRefused };

/** The resource's last answer as the door gave it; a read that never answered is refused in its own words. */
export function readingOf<A>(resource: AsyncResource<DeployHeard<A>>): Reading<A> {
  const heard = lastValue(resource);

  if (heard !== null) return "answer" in heard ? { state: "read", answer: heard.answer } : { state: "refused", refusal: heard.refusal };

  return resource.status === "error"
    ? { state: "refused", refusal: { error: resource.message, status: 0, need: null, refused: null } }
    : { state: "reading" };
}
