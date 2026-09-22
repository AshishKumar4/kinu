import { createContext, useContext, type ReactNode } from "react";
import { getProfile, type UserProfile } from "@/lib/user-api";
import { useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";

interface AccountValue {
  readonly profile: AsyncResource<UserProfile | null>;
  readonly reload: () => void;
  /** Publishes a held profile so the gate never reads a stale `onboardedAt`. */
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
