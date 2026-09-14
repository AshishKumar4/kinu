import { useEffect, useState } from 'react';

/** Whether `query` matches, following the media query live. Starts true with no window so a server render leans wide. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => globalThis.window === undefined || globalThis.window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);

    return () => media.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
