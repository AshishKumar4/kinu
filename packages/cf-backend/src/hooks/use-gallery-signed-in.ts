/** Whether the person on a public page (Explore, a listed slate) is signed in, as `GalleryShell` read it; any other page is. */
import { createContext, useContext } from "react";

export const SignedInContext = createContext(true);

export function useGallerySignedIn(): boolean {
  return useContext(SignedInContext);
}
