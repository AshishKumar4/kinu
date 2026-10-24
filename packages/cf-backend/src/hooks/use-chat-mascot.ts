/**
 * A chat's mascot, wherever it is drawn: a workspace's agents' own, and the person's assistant (Home's workspace, its
 * main chat) drawn from the person's name, so setup, Home and the rail show one face (`personMascot`).
 */
import { lastValue } from "@/hooks/use-async-resource";
import { useAccountIfAny } from "@/hooks/use-account";
import { useWorkspaceRosterIfAny } from "@/hooks/use-workspace-roster";
import { mascotColour, mascotSeed, personMascot, type MascotLook } from "@/components/ui/Marks";
import { personName } from "@kinu.run/core";

/** Each chat's look in `workspace`: `chat` its key, `rank` its place among the workspace's agents. */
export function useMascotOf(workspace: string): (chat: string, rank: number) => MascotLook {
  const roster = useWorkspaceRosterIfAny();
  const account = useAccountIfAny();
  const home = roster?.entries.some((entry) => entry.name === workspace && entry.home === true) === true;
  const person = account === null ? null : lastValue(account.profile);
  const assistant = home && person !== null ? personMascot(personName(person)) : null;

  return (chat, rank) => (assistant !== null && chat === "main" ? assistant : { seed: mascotSeed(workspace, chat), colour: mascotColour(workspace, rank) });
}
