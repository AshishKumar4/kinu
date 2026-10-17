/**
 * Personal parts' client (docs/SLATE-SHARING-NIMBUS.md §3), called by the app page at the top of a slate's window as the
 * signed-in viewer: a part's run, what the viewer confirmed to show everyone, their consents and their decision on an
 * effect. Never called from a part's frame, whose requests carry no session (lib/part-bridge.ts).
 */
import { Cause, Effect } from "effect";
import {
  PartRunAnswerSchema, slateApprovalPath, SlateConsentsAnswerSchema, slateConsentsPath, slatePartRunPath, slatePartShowPath, type PartRunAnswer, type PartRunRequest, type PartShowRequest, type SlateConsent,
} from "@kinu.run/core";
import * as v from "valibot";
import { renderThrownChain, settle } from "@kinu.run/core/obs";
import { posted, refusal, request, respond } from "./http";

/** The part of `title` to run, by its address. */
interface RunPartAt {
  readonly workspace: string;
  readonly slate: string;
  readonly part: string;
  readonly title: string;
}

/**
 * The run's answer, or why it was refused, in the app's words. Refused for want of a session, as when the viewer's has
 * ended, it is the part's own signed-out state, which offers Sign in.
 */
export function runPart({ workspace, slate, part, title }: RunPartAt, asked: PartRunRequest): Promise<PartRunAnswer | string> {
  const path = slatePartRunPath(workspace, slate, part);

  return settle(Effect.catchCause(
    Effect.gen(function* () {
      const res = yield* respond(path, { method: "POST", json: asked });

      if (res.status === 401) return { kind: "stub", reason: "signed-out", message: `Sign in to see your own part of ${title}.` } satisfies PartRunAnswer;

      if (!res.ok) return yield* Effect.die(yield* refusal(res, "POST", path));

      return v.parse(PartRunAnswerSchema, yield* Effect.promise(async () => res.json()));
    }),
    (failed) => Effect.succeed(renderThrownChain({ cause: Cause.squash(failed) })),
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
