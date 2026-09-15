import type { ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import { LoadFailure } from "@/components/ui/LoadFailure";
import type { AsyncResource } from "@/hooks/use-async-resource";

/** One account read, rendered branch-locally: its card shows ITS data, ITS
 *  failure with the retry, or a quiet loader — one read stalling or rejecting
 *  never blanks the cards beside it (KINU-073). */
export function CardSlot<T>({ resource, what, onRetry, children }: {
  resource: AsyncResource<T>;
  what: string;
  onRetry: () => void;
  children: (value: T) => ReactNode;
}) {
  if (resource.status === "error") {
    return (
      <div className="contents" data-settings-resource={what} data-resource-state="error">
        <LoadFailure what={what} message={resource.message} onRetry={onRetry} />
      </div>
    );
  }

  if (resource.status === "loading") {
    return (
      <div className="flex justify-center py-4" data-settings-resource={what} data-resource-state="loading">
        <Loader size="sm" />
      </div>
    );
  }

  return (
    <div className="contents" data-settings-resource={what} data-resource-state="ready">
      {children(resource.value)}
    </div>
  );
}
