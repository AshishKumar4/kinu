import { useCallback } from "react";
import { readImportantMail, type Important } from "@/lib/mail-api";
import { lastValue, useAsyncResource } from "./use-async-resource";

// Mail is taken to be on until the deployment says it is off, so its icon does not appear late where it is on.
const NOTHING: Important = { enabled: true, unread: 0, items: [] };

/** The Important mail's unread count and its newest few; nothing while it reads or when it cannot be read. */
export function useImportantMail(limit = 3): Important {
  const read = useCallback(() => readImportantMail(limit), [limit]);

  return lastValue(useAsyncResource(read).resource) ?? NOTHING;
}
