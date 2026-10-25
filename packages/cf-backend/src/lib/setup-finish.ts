/**
 * Finishing setup after the person's click: the welcome page goes Home at once, and the account's stamp and the
 * assistant's install run here, outside it. Measured on staging 2026-10-25 (a5c2e2110, trial-509): the click waited
 * 3.5 s, 4.9 s and once 43 s on the install, then the stamp, before Home. Home reads the install's progress, the
 * onboarding gate lets a finish that began through, and a failure is shown on whatever page the person is on.
 */
import { useSyncExternalStore } from "react";
import { Effect } from "effect";
import { PERSONAL_ASSISTANT_ID } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { completeOnboarding } from "@/lib/user-api";
import { installBlueprint } from "@/lib/explore-api";

type AssistantInstall =
  | { readonly state: "installing"; readonly name: string }
  | { readonly state: "installed"; readonly workspace: string }
  | { readonly state: "failed"; readonly name: string; readonly error: string };

type SetupStamp = { readonly state: "saving" } | { readonly state: "saved" } | { readonly state: "failed"; readonly error: string };

export interface SetupFinish {
  /** Null when the person chose no assistant. */
  readonly assistant: AssistantInstall | null;
  readonly stamp: SetupStamp;
  /** The person put the failures shown away; a retry shows them again. */
  readonly dismissed: boolean;
}

let current: SetupFinish | null = null;

/** Hears the account's own stamp once it is saved: the welcome page's, which publishes it to the account. */
let stamped: (onboardedAt: number) => void = () => {};

const listeners = new Set<() => void>();

function publish(change: Partial<SetupFinish>): void {
  current = { assistant: null, stamp: { state: "saving" }, dismissed: false, ...current, ...change };

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => { listeners.delete(listener); };
}

/** This page's finish, or null while setup has not finished here. */
export function useSetupFinish(): SetupFinish | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Whether setup finished in this page: the gate does not send the person back while the stamp is still out. */
export function setupFinishing(): boolean {
  return current !== null;
}

function install(name: string): Effect.Effect<void> {
  return Effect.suspend(() => {
    publish({ assistant: { state: "installing", name } });

    // Its brief keeps the blueprint's 08:00 in the person's own time zone; the time is changed in its settings.
    return Effect.tryPromise({ try: () => installBlueprint(PERSONAL_ASSISTANT_ID, { displayName: name, agent: name, home: true }), catch: (cause) => cause }).pipe(
      Effect.map((workspace) => { publish({ assistant: { state: "installed", workspace } }); }),
      Effect.catch((cause) => Effect.sync(() => { publish({ assistant: { state: "failed", name, error: renderThrownChain({ cause }) } }); })),
    );
  });
}

function stamp(): Effect.Effect<void> {
  return Effect.suspend(() => {
    publish({ stamp: { state: "saving" } });

    return Effect.tryPromise({ try: () => completeOnboarding(), catch: (cause) => cause }).pipe(
      Effect.map(({ onboardedAt }) => {
        publish({ stamp: { state: "saved" } });
        stamped(onboardedAt);
      }),
      Effect.catch((cause) => Effect.sync(() => { publish({ stamp: { state: "failed", error: renderThrownChain({ cause }) } }); })),
    );
  });
}

/** The stamp and the install side by side; published as begun the moment it runs, which the caller does at its click. */
export function finishSetup(assistant: string | null, onStamped: (onboardedAt: number) => void): Effect.Effect<void> {
  return Effect.suspend(() => {
    stamped = onStamped;
    publish({ assistant: null, dismissed: false });

    return Effect.all([stamp(), assistant === null ? Effect.void : install(assistant)], { concurrency: "unbounded", discard: true });
  });
}

/** Runs again what failed: the stamp, the install, or both. */
export function retrySetupFinish(): Effect.Effect<void> {
  return Effect.suspend(() => {
    const failed = current;

    publish({ dismissed: false });

    return Effect.all([
      failed?.stamp.state === "failed" ? stamp() : Effect.void,
      failed?.assistant?.state === "failed" ? install(failed.assistant.name) : Effect.void,
    ], { concurrency: "unbounded", discard: true });
  });
}

/** Puts the failures away: the person carries on without them. */
export function dismissSetupFinish(): void {
  publish({ dismissed: true });
}
