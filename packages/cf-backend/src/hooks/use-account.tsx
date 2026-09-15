/**
 * The signed-in account's profile, as one shared read.
 *
 * Before this existed, every surface that needed the profile fetched it on its
 * own — the sidebar read it for the account row, the gate read it to know
 * whether to redirect, the settings page read it for the Profile card. Three
 * copies meant three chances to disagree about what the account looks like,
 * and the onboarding gate in particular could not redirect a user whose
 * sidebar had already rendered their email. One provider answers for
 * everything under it.
 */
import { createContext, useContext, type ReactNode } from "react";
import { getProfile, type UserProfile } from "@/lib/user-api";
import { useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";

interface AccountValue {
  readonly profile: AsyncResource<UserProfile | null>;
  readonly reload: () => void;
  /** Publish a profile the caller already holds (a mutation's own answer),
   *  so the gate never reads a stale `onboardedAt` while the reload lands. */
  readonly set: (value: UserProfile | null) => void;
}

const AccountContext = createContext<AccountValue | null>(null);

export function AccountProvider({ children }: { readonly children: ReactNode }) {
  const { resource, reload, set } = useAsyncResource(getProfile);

  return (
    <AccountContext.Provider value={{ profile: resource, reload, set }}>
      {children}
    </AccountContext.Provider>
  );
}

export function useAccount(): AccountValue {
  const account = useContext(AccountContext);

  if (account === null) throw new Error("useAccount requires AccountProvider");

  return account;
}
