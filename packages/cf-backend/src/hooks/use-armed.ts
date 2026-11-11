import { useEffect, useState } from "react";

/**
 * How long a sheet a framed app can open waits before its primary button takes a press: a click the app asked for on its
 * own page, landing a moment after the sheet opens, must not answer it.
 */
const ARMS_AFTER_MS = 600;

/** False until the sheet has been open long enough to take its visitor's own press. */
export function useArmed(): boolean {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => { setArmed(true); }, ARMS_AFTER_MS);

    return () => { clearTimeout(timer); };
  }, []);

  return armed;
}
