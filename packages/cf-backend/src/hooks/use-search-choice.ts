import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/** A listing page's filters, kept in its URL: `choose(key, value)` sets one, or clears it for null or "". Typing a
 *  search (`q`) replaces the history entry; a filter pushes one. */
export function useSearchChoice(): readonly [URLSearchParams, (key: string, value: string | null) => void] {
  const [search, setSearch] = useSearchParams();

  const choose = useCallback((key: string, value: string | null) => {
    setSearch((prior) => {
      const next = new URLSearchParams(prior);

      if (value === null || value === "") next.delete(key);
      else next.set(key, value);

      return next;
    }, { replace: key === "q" });
  }, [setSearch]);

  return [search, choose];
}
