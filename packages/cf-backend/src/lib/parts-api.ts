/**
 * Personal parts' client (docs/SLATE-SHARING-NIMBUS.md §3), called by the app page at the top of a slate's window as the
 * signed-in viewer: a part's run, what the viewer confirmed to show everyone, their consents and their decision on an
 * effect. Never called from a part's frame, whose requests carry no session (lib/part-bridge.ts).
 */
import { Effect } from "effect";
import {
  PartRunAnswerSchema, slateApprovalPath, SlateConsentsAnswerSchema, slateConsentsPath, slatePartRunPath, slatePartShowPath, type PartRunAnswer, type PartRunRequest, type PartShowRequest, type SlateConsent,
} from "@kinu.run/core";
import { renderThrownChain, settle } from "@kinu.run/core/obs";
import { posted, request } from "./http";

/** The run's answer, or why it was refused, in the app's words. */
export function runPart(workspace: string, slate: string, part: string, asked: PartRunRequest): Promise<PartRunAnswer | string> {
  return settle(Effect.catchCause(
    request(PartRunAnswerSchema, slatePartRunPath(workspace, slate, part), { method: "POST", json: asked }),
    (cause) => Effect.succeed(renderThrownChain({ cause })),
  ));
}

export function showPart(workspace: string, slate: string, part: string, shown: PartShowRequest): Promise<void> {
  return settle(posted(slatePartShowPath(workspace, slate, part), shown));
}

export function readConsents(workspace: string, slate: string): Promise<readonly SlateConsent[]> {
  return settle(Effect.map(request(SlateConsentsAnswerSchema, slateConsentsPath(workspace, slate)), (answer) => answer.consents));
}

export function giveConsent(consent: SlateConsent): Promise<void> {
  return settle(posted(slateConsentsPath(consent.workspace, consent.slate), { ...consent, root: { ...consent.root }, tools: [...consent.tools] }));
}

export function decideEffect(workspace: string, slate: string, approval: string, decision: "approve" | "decline"): Promise<void> {
  return settle(posted(slateApprovalPath(workspace, slate, approval), { decision }));
}
